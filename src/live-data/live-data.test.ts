import { test } from "node:test";
import assert from "node:assert/strict";
import { constants, generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { ed25519FromBase64Seed, loadDotEnv, readStreamCreds } from "./credentials.js";
import { kalshiWsHeaders, polymarketUsHeaders, KALSHI_WS_PATH, POLYMARKET_US_WS_PATH } from "./signing.js";
import { QuoteBook, withLiveQuote } from "./quotes.js";
import { KalshiStream, PolymarketUsStream } from "./streams.js";
import { LiveQuoteAdapter } from "./live-adapter.js";
import { DemoAdapter } from "../platforms/demo.js";
import type { PlatformAdapter } from "../platforms/types.js";
import type { NormalizedMarket } from "../types.js";
import { runPaperCycle } from "../engine/paper-session.js";
import type { PaperLedger } from "../ledger/paper.js";

const until = async (fn: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
};

test("Kalshi handshake: RSA-PSS (salt = digest) or Ed25519 over timestamp + GET + path", () => {
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const h = kalshiWsHeaders("kid", rsa.privateKey, 1_700_000_000_123);
  assert.equal(h["KALSHI-ACCESS-KEY"], "kid");
  assert.equal(h["KALSHI-ACCESS-TIMESTAMP"], "1700000000123");
  const msg = Buffer.from(`1700000000123GET${KALSHI_WS_PATH}`);
  assert.ok(
    verify("sha256", msg, { key: rsa.publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(h["KALSHI-ACCESS-SIGNATURE"], "base64")),
  );
  const ed = generateKeyPairSync("ed25519");
  const h2 = kalshiWsHeaders("kid", ed.privateKey, 5);
  assert.ok(verify(null, Buffer.from(`5GET${KALSHI_WS_PATH}`), ed.publicKey, Buffer.from(h2["KALSHI-ACCESS-SIGNATURE"], "base64")));
});

test("Polymarket US handshake: Ed25519 from the base64 secret (32- or 64-byte form)", () => {
  const seed = Buffer.alloc(32, 7);
  const key32 = ed25519FromBase64Seed(seed.toString("base64"));
  const pub = createPublicKey(key32);
  const key64 = ed25519FromBase64Seed(Buffer.concat([seed, Buffer.alloc(32, 1)]).toString("base64"));
  const h = polymarketUsHeaders("pid", key64, "GET", POLYMARKET_US_WS_PATH, 42);
  assert.deepEqual(Object.keys(h), ["X-PM-Access-Key", "X-PM-Timestamp", "X-PM-Signature"]);
  assert.ok(verify(null, Buffer.from(`42GET${POLYMARKET_US_WS_PATH}`), pub, Buffer.from(h["X-PM-Signature"], "base64")));
  assert.throws(() => ed25519FromBase64Seed(Buffer.alloc(10).toString("base64")), /32- or 64-byte/);
});

test(".env loading and key problems never echo the secret", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-env-"));
  const file = path.join(dir, ".env");
  await writeFile(file, `# comment\nPOLYMARKET_KEY_ID=abc\nPOLYMARKET_SECRET_KEY="not-base64-secret!!"\nexport KALSHI_API_KEY_ID=k1\n`);
  const env: NodeJS.ProcessEnv = { KALSHI_API_KEY_ID: "already-set" };
  assert.equal(loadDotEnv(file, env), true);
  assert.equal(env.POLYMARKET_KEY_ID, "abc");
  assert.equal(env.KALSHI_API_KEY_ID, "already-set", "the real environment wins");
  const creds = readStreamCreds(env);
  assert.equal(creds.polymarketUs, undefined);
  assert.equal(creds.kalshi, undefined);
  assert.ok(creds.problems.some((p) => /POLYMARKET_SECRET_KEY/.test(p)));
  assert.ok(creds.problems.some((p) => /KALSHI_PRIVATE_KEY_PATH/.test(p)));
  assert.ok(creds.problems.every((p) => !p.includes("not-base64-secret")));
  assert.equal(loadDotEnv(path.join(dir, "missing.env"), {}), false);
  // A key pasted where the path goes, or a mistyped path, is never echoed back.
  const pasted = readStreamCreds({ KALSHI_API_KEY_ID: "k", KALSHI_PRIVATE_KEY_PATH: "-----BEGIN PRIVATE KEY-----\\nMIIEvSECRET" });
  assert.ok(pasted.problems.length === 1 && !pasted.problems[0].includes("SECRET") && /not the key itself/.test(pasted.problems[0]));
  const missing = readStreamCreds({ KALSHI_API_KEY_ID: "k", KALSHI_PRIVATE_KEY_PATH: "/tmp/does-not-exist/my-secret-folder/k.key" });
  assert.ok(missing.problems.length === 1 && !missing.problems[0].includes("my-secret-folder"));
});

test("streams keep one socket, honour the backoff, and clear their quotes when they drop", async () => {
  let connections = 0;
  const { wss, port } = await server(() => true);
  wss.on("connection", (ws) => {
    connections += 1;
    if (connections === 1) ws.send(JSON.stringify({ type: "ticker", msg: { market_ticker: "A", yes_bid_dollars: "0.40", yes_ask_dollars: "0.42" } }));
    setTimeout(() => ws.close(), 50);
  });
  const ed = generateKeyPairSync("ed25519");
  const quotes = new QuoteBook();
  const s = new KalshiStream(quotes, { keyId: "k", key: ed.privateKey }, { url: `ws://127.0.0.1:${port}${KALSHI_WS_PATH}` });
  s.setMarkets(["A"]);
  s.start();
  try {
    await until(() => quotes.get("kalshi", "A") != null);
    await until(() => s.status.state === "retrying");
    assert.equal(quotes.get("kalshi", "A"), undefined, "quotes from a dropped socket aren't trusted");
    s.setMarkets(["A", "B"]); // new markets while a retry is pending: no extra socket
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(connections, 1);
    s.stop();
    await new Promise((r) => setTimeout(r, 2300));
    assert.equal(connections, 1, "stop() cancels the pending retry");
  } finally {
    s.stop();
    wss.close();
  }
});

test("Kalshi key file: PEM path from .env (with ~) loads", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-key-"));
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
  const keyPath = path.join(dir, "kalshi.key");
  await writeFile(keyPath, privateKey);
  const creds = readStreamCreds({ KALSHI_API_KEY_ID: "kid", KALSHI_PRIVATE_KEY_PATH: keyPath });
  assert.equal(creds.kalshi?.keyId, "kid");
  assert.equal(creds.kalshi?.key.asymmetricKeyType, "rsa");
  assert.deepEqual(creds.problems, []);
});

async function server(check: (req: { url?: string; headers: Record<string, unknown> }) => boolean) {
  const wss = new WebSocketServer({
    port: 0,
    verifyClient: (info, done) => done(check({ url: info.req.url, headers: info.req.headers as Record<string, unknown> }), 401),
  });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  return { wss, port: (wss.address() as AddressInfo).port };
}

test("Kalshi stream: signed handshake, one ticker subscription, quotes in dollars", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const { wss, port } = await server(({ url, headers }) => {
    const ts = String(headers["kalshi-access-timestamp"]);
    return (
      url === KALSHI_WS_PATH &&
      verify("sha256", Buffer.from(`${ts}GET${KALSHI_WS_PATH}`), { key: publicKey, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST }, Buffer.from(String(headers["kalshi-access-signature"]), "base64"))
    );
  });
  const subs: unknown[] = [];
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      subs.push(JSON.parse(d.toString()));
      ws.send(JSON.stringify({ type: "ticker", sid: 1, msg: { market_ticker: "FED-X", yes_bid_dollars: "0.4500", yes_ask_dollars: "0.5300", price_dollars: "0.4800" } }));
      ws.send(JSON.stringify({ type: "ticker", sid: 1, msg: { market_ticker: "EMPTY", yes_bid_dollars: "0.0000", yes_ask_dollars: "1.0000" } }));
    });
  });
  const quotes = new QuoteBook();
  const s = new KalshiStream(quotes, { keyId: "kid", key: privateKey }, { url: `ws://127.0.0.1:${port}${KALSHI_WS_PATH}` });
  s.setMarkets(["FED-X", "EMPTY"]);
  s.start();
  try {
    await until(() => quotes.get("kalshi", "EMPTY") != null);
    assert.deepEqual(subs, [{ id: 1, cmd: "subscribe", params: { channels: ["ticker"], market_tickers: ["FED-X", "EMPTY"] } }]);
    const q = quotes.get("kalshi", "FED-X")!;
    assert.deepEqual([q.bid, q.ask, q.last], [0.45, 0.53, 0.48]);
    const e = quotes.get("kalshi", "EMPTY")!;
    assert.deepEqual([e.bid, e.ask], [undefined, undefined], "0 / 1 are empty book sides, not prices");
    assert.equal(s.status.state, "live");
  } finally {
    s.stop();
    wss.close();
  }
});

test("streams stop retrying when the exchange rejects the key", async () => {
  const { wss, port } = await server(() => false);
  const ed = generateKeyPairSync("ed25519");
  const s = new PolymarketUsStream(new QuoteBook(), { keyId: "bad", key: ed.privateKey }, { url: `ws://127.0.0.1:${port}${POLYMARKET_US_WS_PATH}` });
  s.setSlugs([{ id: "1", slug: "m-1" }]);
  s.start();
  try {
    await until(() => s.status.state === "auth_failed");
    assert.match(s.status.error ?? "", /rejected the API key/);
  } finally {
    s.stop();
    wss.close();
  }
});

test("Polymarket US stream: 100 markets per subscription, BBO keyed back to market ids", async () => {
  const ed = generateKeyPairSync("ed25519");
  const { wss, port } = await server(({ headers }) =>
    verify(null, Buffer.from(`${headers["x-pm-timestamp"]}GET${POLYMARKET_US_WS_PATH}`), ed.publicKey, Buffer.from(String(headers["x-pm-signature"]), "base64")),
  );
  const subs: Array<{ subscribe: { requestId: string; subscriptionType: string; marketSlugs: string[] } }> = [];
  wss.on("connection", (ws) => {
    ws.on("message", (d) => {
      subs.push(JSON.parse(d.toString()));
      if (subs.length === 1) {
        ws.send(JSON.stringify({ heartbeat: {} }));
        ws.send(JSON.stringify({ requestId: "bbo-0", subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA_LITE", marketDataLite: { marketSlug: "m-7", bestBid: { value: "0.61" }, bestAsk: { value: "0.62" }, lastTradePx: { value: "0.615" } } }));
      }
    });
  });
  const quotes = new QuoteBook();
  const s = new PolymarketUsStream(quotes, { keyId: "pid", key: ed.privateKey }, { url: `ws://127.0.0.1:${port}${POLYMARKET_US_WS_PATH}` });
  s.setSlugs(Array.from({ length: 150 }, (_, i) => ({ id: String(i), slug: `m-${i}` })));
  s.start();
  try {
    await until(() => quotes.get("polymarket_us", "7") != null && subs.length === 2);
    assert.deepEqual(subs.map((x) => x.subscribe.marketSlugs.length), [100, 50]);
    assert.equal(subs[0].subscribe.subscriptionType, "SUBSCRIPTION_TYPE_MARKET_DATA_LITE");
    const q = quotes.get("polymarket_us", "7")!;
    assert.deepEqual([q.bid, q.ask, q.last], [0.61, 0.62, 0.615]);
  } finally {
    s.stop();
    wss.close();
  }
});

test("live quotes replace bid/ask only while fresh, and only on open markets", () => {
  const m: NormalizedMarket = { platform: "kalshi", id: "A", title: "a", yesPrice: 0.5, yesBid: 0.49, yesAsk: 0.51, liquidityUsd: 9000 };
  const q = { bid: 0.6, ask: 0.62, at: 1000 };
  const live = withLiveQuote(m, q, 5000, 2000);
  assert.deepEqual([live.yesBid, live.yesAsk, live.yesPrice, live.liquidityUsd], [0.6, 0.62, 0.61, 9000]);
  assert.ok(live.quotedAt);
  assert.equal(withLiveQuote(m, q, 5000, 10_000), m, "stale quote ignored");
  assert.equal(withLiveQuote({ ...m, status: "closed" }, q, 5000, 2000).yesBid, 0.49, "closed markets keep REST data");
  const empty = withLiveQuote(m, { at: 1000 }, 5000, 2000);
  assert.deepEqual([empty.yesBid, empty.yesAsk], [undefined, undefined], "a streamed empty book is untradeable, not the old REST quote");
  assert.ok(empty.quotedAt);
  assert.equal(withLiveQuote(m, q, 5000, 2000).quotedAt != null, true);
  const book = new QuoteBook();
  book.set("kalshi", "A", { bid: 0.4, ask: 0.42 });
  book.set("kalshi", "A", { last: 0.41 });
  assert.deepEqual([book.get("kalshi", "A")!.bid, book.get("kalshi", "A")!.last], [0.4, 0.41], "partial updates keep the other fields");
  book.set("kalshi", "A", { bid: undefined });
  assert.equal(book.get("kalshi", "A")!.bid, undefined, "an emptied side is cleared");
});

test("live adapter caches REST between full checks and overlays streamed quotes", async () => {
  let t = 0;
  let calls = 0;
  const inner: PlatformAdapter = {
    id: "kalshi",
    async listMarkets() {
      calls++;
      return [{ platform: "kalshi", id: "A", title: "a", yesPrice: 0.5, yesBid: 0.49, yesAsk: 0.51 }];
    },
    async getMarket(id) {
      calls++;
      return { platform: "kalshi", id, title: id, yesPrice: 0.3, yesBid: 0.29, yesAsk: 0.31 };
    },
    roundContracts: (c) => Math.floor(c),
  };
  const quotes = new QuoteBook();
  const watched: string[] = [];
  const a = new LiveQuoteAdapter(inner, quotes, { refreshMs: 60_000, maxQuoteAgeMs: 10_000, now: () => t, watch: (ms, src) => watched.push(`${src}:${ms.map((m) => m.id)}`) });
  assert.equal((await a.listMarkets({ limit: 10 }))[0].yesBid, 0.49);
  quotes.set("kalshi", "A", { bid: 0.55, ask: 0.56 }, 0);
  t = 5000;
  const [live] = await a.listMarkets({ limit: 10 });
  assert.equal(live.yesBid, 0.55);
  assert.equal(calls, 1, "no REST call between full checks");
  await a.getMarket("B");
  await a.getMarket("B");
  assert.equal(calls, 2);
  a.refresh();
  await a.listMarkets({ limit: 10 });
  assert.equal(calls, 3, "a full check re-reads the listing");
  assert.equal(a.roundContracts!(5.7), 5);
  assert.deepEqual(watched, ["listing:A", "lookup:B", "listing:A"]);
});

test("fast checks sell on a live quote without touching the prices that move-based rules compare against", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-fast-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: flip
    name: flip
    action: paper
    filters: { platforms: [kalshi], min_price: 0.4, max_price: 0.6 }
    entry: { side: yes }
    exit: { take_profit_price: 0.58 }
    risk: { position_size_fraction: 0.05, reentry_cooldown_hours: 1 }
  - id: watchlist
    name: watchlist
    action: alert
    filters: { platforms: [kalshi] }
`,
  );
  const fixture = path.join(dir, "m.json");
  await writeFile(fixture, JSON.stringify([{ platform: "kalshi", id: "K", title: "K", yesPrice: 0.5, yesBid: 0.49, yesAsk: 0.51, closesInHours: 100 }]));
  const ledgerPath = path.join(dir, "ledger.json");
  const quotes = new QuoteBook();
  const wrappers = new Map<string, LiveQuoteAdapter>();
  const wrap = (list: PlatformAdapter[]) =>
    list.map((x) => wrappers.get(x.id) ?? wrappers.set(x.id, new LiveQuoteAdapter(x, quotes, { refreshMs: 600_000, maxQuoteAgeMs: 60_000 })).get(x.id)!);
  const adapters = [new DemoAdapter("kalshi", { fixturePath: fixture })];
  const events: string[] = [];
  const run = (fastTick: boolean) =>
    runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, adapters, wrapAdapters: wrap, fastTick, emit: (e) => void events.push(e.type) });

  const full = await run(false);
  assert.equal(full.opened, 1);
  const before = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.equal(before.lastPrices["kalshi:K"]?.yesPrice, 0.5);

  // A quick check doesn't trade on cached REST data, even when it would hit the target.
  await writeFile(fixture, JSON.stringify([{ platform: "kalshi", id: "K", title: "K", yesPrice: 0.6, yesBid: 0.59, yesAsk: 0.61, closesInHours: 100 }]));
  wrappers.get("kalshi")!.refresh();
  await wrappers.get("kalshi")!.listMarkets({ limit: 400 });
  assert.equal((await run(true)).closed, 0, "no live quote → wait for the full check");

  events.length = 0;
  quotes.set("kalshi", "K", { bid: 0.59, ask: 0.6 });
  const tick = await run(true);
  assert.equal(tick.closed, 1, "take profit fires on the streamed bid");
  const after = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const pos = after.positions[0];
  assert.equal(pos.exitReason, "take_profit");
  assert.equal(pos.exitPrice, 0.59);
  assert.equal(after.lastPrices["kalshi:K"]?.yesPrice, 0.5, "fast checks keep the last full check's prices");
  assert.ok(!tick.events.some((e) => e.type === "entry_signal" && e.ruleId === "watchlist"), "alert-only rules wait for full checks");
});
