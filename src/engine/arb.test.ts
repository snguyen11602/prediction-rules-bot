import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArbitrageSchema } from "../rules/schema.js";
import { kalshiTakerFeeUsd } from "../platforms/kalshi.js";
import { DemoAdapter } from "../platforms/demo.js";
import type { EngineEvent, NormalizedMarket, PlatformId } from "../types.js";
import { bestQuotes, discoverBaskets, pairKey, quoteBasket, unwindProceeds, type QuoteEnv } from "./arb.js";
import { runPaperCycle } from "./paper-session.js";
import { runScan } from "./runner.js";
import type { PaperLedger } from "../ledger/paper.js";
import { readFile } from "node:fs/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = new Date("2026-10-26T19:00:00Z");
const cfg = ArbitrageSchema.parse({});
const env: QuoteEnv = {
  slippage: 0.005,
  includeFees: true,
  now: NOW,
  feeFor: (m: NormalizedMarket, c: number, price: number) => (m.platform === "kalshi" ? kalshiTakerFeeUsd(c, price) : 0),
  roundSets: (pls: PlatformId[], s: number) => (pls.includes("kalshi") ? Math.floor(s) : Math.floor(s * 100) / 100),
};
const closes = new Date(NOW.getTime() + 500 * 3600_000).toISOString();
const mk = (platform: PlatformId, id: string, bid: number, ask: number, over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform,
  id,
  title: id,
  yesPrice: (bid + ask) / 2,
  yesBid: bid,
  yesAsk: ask,
  closesAt: closes,
  ...over,
});

test("cross-platform quote: cheaper direction, whole Kalshi contracts, fees included", async () => {
  const K = mk("kalshi", "K", 0.56, 0.57);
  const P = mk("polymarket", "P", 0.635, 0.645);
  const d = await discoverBaskets({
    cfg,
    pairs: { confirmed: [{ kalshi: "K", polymarket: "P", invert: false }], blocked: [] },
    markets: [K, P],
    eventGroups: [],
  });
  const [q] = bestQuotes(d.baskets, 100, env);
  assert.deepEqual(q.legs.map((l) => `${l.market.platform}:${l.side}`), ["kalshi:yes", "polymarket:no"]);
  // Fees count toward the $100 size: 103 sets × 0.945 = $97.34 + $1.77 Kalshi fee ≤ $100.
  assert.equal(q.sets, 103);
  assert.equal(q.costUsd, 97.34);
  assert.equal(q.feesUsd, 1.77);
  assert.ok(q.costUsd + q.feesUsd <= 100);
  assert.equal(q.profitUsd, 3.89);
  assert.ok(q.edge > 0.037 && q.edge < 0.039);
});

test("no arb when costs eat the gap; no arb without real quotes on both sides", () => {
  const basket = (K: NormalizedMarket, P: NormalizedMarket) => ({
    key: "k",
    kind: "cross_platform" as const,
    title: "t",
    legs: [
      { market: K, side: "yes" as const },
      { market: P, side: "no" as const },
    ],
    payoutPerSet: 1,
    matchedBy: "confirmed" as const,
  });
  // 2¢ apart on screen, but after spread, slippage and fees it's not profitable.
  const q = quoteBasket(basket(mk("kalshi", "K", 0.5, 0.51), mk("polymarket", "P", 0.52, 0.53)), { sizeUsd: 100 }, env);
  assert.ok(!q || q.profitUsd <= 0);
  const noBid = mk("polymarket", "P", 0.6, 0.61);
  delete noBid.yesBid;
  assert.equal(quoteBasket(basket(mk("kalshi", "K", 0.5, 0.51), noBid), { sizeUsd: 100 }, env), null);
});

test("same-site baskets: NO basket on exclusive events, YES basket only when one must win", async () => {
  const outcomes = [mk("polymarket", "A", 0.52, 0.53), mk("polymarket", "B", 0.38, 0.39), mk("polymarket", "C", 0.16, 0.17)];
  const group = { platform: "polymarket" as const, eventId: "E", title: "Race", mutuallyExclusive: true, exhaustive: false, markets: outcomes };
  const d = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [group] });
  assert.deepEqual(d.baskets.map((b) => b.kind), ["no_basket"], "YES basket needs an exhaustive event");
  const [q] = bestQuotes(d.baskets, 100, env);
  assert.equal(q.basket.payoutPerSet, 2); // NO on 3 mutually exclusive outcomes: at least 2 pay
  assert.equal(q.profitUsd, 2.3);

  const notExclusive = { ...group, mutuallyExclusive: false };
  const d2 = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [notExclusive] });
  assert.equal(d2.baskets.length, 0, "strike ladders etc. (not exclusive) are never basketed");

  const cheap = [mk("polymarket", "X", 0.29, 0.3), mk("polymarket", "Y", 0.24, 0.25), mk("polymarket", "O", 0.16, 0.17)];
  const exh = { ...group, eventId: "F", markets: cheap, exhaustive: true };
  const off = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [exh] });
  assert.ok(!off.baskets.some((b) => b.kind === "yes_basket"), "YES baskets are off by default");
  const yesCfg = ArbitrageSchema.parse({ same_platform: { yes_basket: true } });
  const d3 = await discoverBaskets({ cfg: yesCfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [exh] });
  const yes = bestQuotes(d3.baskets, 100, env).find((x) => x.basket.kind === "yes_basket");
  assert.ok(yes && yes.basket.payoutPerSet === 1 && yes.profitUsd > 0);
});

test("pairs file: inverted pairs hedge YES+YES; blocked pairs and wide auto pairs are skipped", async () => {
  const K = mk("kalshi", "K", 0.3, 0.31, { title: "Will the Fed cut rates by 25bps in December 2026?" });
  const P = mk("polymarket", "P", 0.62, 0.63, { title: "Fed cuts rates 25 bps in December 2026?", outcomes: ["Yes", "No"] });
  const inv = await discoverBaskets({
    cfg,
    pairs: { confirmed: [{ kalshi: "K", polymarket: "P", invert: true }], blocked: [] },
    markets: [K, P],
    eventGroups: [],
  });
  const sides = inv.baskets.map((b) => b.legs.map((l) => l.side).join("+")).sort();
  assert.deepEqual(sides, ["no+no", "yes+yes"]);

  const blocked = await discoverBaskets({
    cfg,
    pairs: { confirmed: [], blocked: [{ kalshi: "K", polymarket: "P" }] },
    markets: [K, P],
    eventGroups: [],
  });
  assert.equal(blocked.baskets.length, 0);

  // Auto-matched but 32¢ apart: almost certainly different questions.
  const wide = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [K, P], eventGroups: [] });
  assert.equal(wide.baskets.length, 0);
  assert.match(wide.skipped[0]?.reason ?? "", /apart/);
  assert.equal(wide.skipped[0]?.key, pairKey("K", "P"));
});

test("unwind proceeds use bids and exit fees", () => {
  const u = unwindProceeds(
    [
      { market: mk("kalshi", "K", 0.66, 0.67), side: "yes", contracts: 105 },
      { market: mk("polymarket", "P", 0.61, 0.62), side: "no", contracts: 105 },
    ],
    env,
  );
  assert.ok(u);
  assert.deepEqual(u!.prices.map((x) => Math.round(x * 1000) / 1000), [0.655, 0.375]);
  assert.equal(u!.proceedsUsd, 106.48);
});

test("a 'hedge' that loses on both legs counts as one loss, and two of them pause arbitrage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-arb-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:\n  - id: noop\n    name: noop\n    filters: { keywords_any: [zzzz] }\narbitrage:\n  cross_platform: { auto_match: false }\n  same_platform: { enabled: false }\n  unwind_early: false\n`,
  );
  // Two confirmed pairs that were NOT really the same question.
  await writeFile(
    path.join(dir, "arb-pairs.yaml"),
    `confirmed:\n  - { kalshi: K1, polymarket: P1 }\n  - { kalshi: K2, polymarket: P2 }\n`,
  );
  const open = (id: string, b: number, a: number, platform: PlatformId) => ({ ...mk(platform, id, b, a), closesInHours: 100 });
  const snap1 = path.join(dir, "s1.json");
  await writeFile(snap1, JSON.stringify([open("K1", 0.4, 0.41, "kalshi"), open("P1", 0.46, 0.47, "polymarket"), open("K2", 0.4, 0.41, "kalshi"), open("P2", 0.46, 0.47, "polymarket")]));
  const resolved = (id: string, platform: PlatformId, outcome: "yes" | "no") => ({
    platform, id, title: id, yesPrice: outcome === "yes" ? 1 : 0, status: "resolved", resolvedOutcome: outcome, closesInHours: -1,
  });
  // Kalshi resolves NO while Polymarket resolves YES: YES(K) and NO(P) both lose.
  const snap2 = path.join(dir, "s2.json");
  await writeFile(snap2, JSON.stringify([resolved("K1", "kalshi", "no"), resolved("P1", "polymarket", "yes"), resolved("K2", "kalshi", "no"), resolved("P2", "polymarket", "yes")]));

  const ledgerPath = path.join(dir, "ledger.json");
  const run = async (fixture: string, now: Date) => {
    const events: EngineEvent[] = [];
    const res = await runPaperCycle({
      rulesPath: rules,
      ledgerPath,
      demo: true,
      now,
      emit: (e) => {
        events.push(e);
      },
      adapters: (["kalshi", "polymarket"] as const).map((id) => new DemoAdapter(id, { fixturePath: fixture, now: () => now })),
    });
    return { ...res, events };
  };
  const r1 = await run(snap1, NOW);
  assert.equal(r1.arb?.opened, 2);
  const r2 = await run(snap2, new Date(NOW.getTime() + 3600_000));
  assert.equal(r2.arb?.closed, 2);
  assert.ok((r2.arb?.realizedPnlUsd ?? 0) < -150);
  assert.ok(r2.events.some((e) => e.type === "arb_close" && /LOSS/.test(e.message)));
  assert.ok(r2.events.some((e) => e.type === "risk_block" && e.ruleId === "arbitrage" && /pause armed/.test(e.message)));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.ok(ledger.ruleState.arbitrage?.pausedUntil);
  assert.equal(Object.values(ledger.arbGroups ?? {}).filter((g) => g.status === "closed").length, 2);
});

test("scan reports arbitrage as alerts and never opens positions; watch alerts once", async () => {
  const events: EngineEvent[] = [];
  const lastMatched = new Set<string>();
  const opts = {
    rulesPath: path.join(ROOT, "rules/example.yaml"),
    demo: true,
    emit: (e: EngineEvent) => {
      events.push(e);
    },
    lastMatched,
  };
  await runScan(opts);
  const first = events.filter((e) => e.type === "arb_signal");
  assert.equal(first.length, 2, "Fed pair (auto-matched) + mayor NO basket; YES baskets are off by default");
  assert.ok(first.every((e) => e.data?.action === "alert"));
  assert.equal(events.filter((e) => e.type === "arb_open").length, 0);
  events.length = 0;
  await runScan(opts);
  assert.equal(events.filter((e) => e.type === "arb_signal").length, 0, "watch: no repeat alerts");
});

test("an event with an outcome already resolved YES is never basketed", async () => {
  const outcomes = [
    mk("polymarket", "A", 0.52, 0.53),
    mk("polymarket", "B", 0.6, 0.61),
    { ...mk("polymarket", "C", 0, 0), status: "resolved" as const, resolvedOutcome: "yes" as const, yesBid: undefined, yesAsk: undefined },
  ];
  const d = await discoverBaskets({
    cfg,
    pairs: { confirmed: [], blocked: [] },
    markets: [],
    eventGroups: [{ platform: "polymarket", eventId: "E", title: "Decided", mutuallyExclusive: true, exhaustive: false, markets: outcomes }],
  });
  assert.equal(d.baskets.length, 0);
});

test("pairs file must stay in the rules folder; YAML errors don't echo file contents", async () => {
  const { pairsFilePath, loadPairsFile } = await import("./arb.js");
  const bad = ArbitrageSchema.parse({ cross_platform: { pairs_file: "../../.env" } });
  assert.throws(() => pairsFilePath("/repo/rules/example.yaml", bad), /inside/);
  const dir = await mkdtemp(path.join(tmpdir(), "prb-pairs-"));
  const file = path.join(dir, "arb-pairs.yaml");
  await writeFile(file, "confirmed: [\nSECRET_TOKEN=abc123\n");
  await assert.rejects(loadPairsFile(file), (err: Error) => /not valid YAML/.test(err.message) && !/abc123/.test(err.message));
});

test("Polymarket fees come from each market's schedule", async () => {
  const { PolymarketAdapter, polymarketTakerFeeUsd } = await import("../platforms/polymarket.js");
  assert.equal(polymarketTakerFeeUsd(100, 0.5, 0.05), 1.25);
  assert.equal(polymarketTakerFeeUsd(100, 0.5, 0), 0);
  const a = new PolymarketAdapter("https://gamma.test");
  const real = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify([
        { id: "1", question: "free", outcomePrices: '["0.5","0.5"]', feeType: "zero_fees", feeSchedule: { rate: 0 }, bestBid: 0.49, bestAsk: 0.51 },
        { id: "2", question: "sports", outcomePrices: '["0.5","0.5"]', feeType: "sports_fees_v3", feeSchedule: { rate: 0.05, exponent: 1 }, bestBid: 0.49, bestAsk: 0.51 },
        { id: "3", question: "paused", outcomePrices: '["0.5","0.5"]', acceptingOrders: false, bestBid: 0.49, bestAsk: 0.51 },
      ]),
    )) as typeof fetch;
  try {
    const [free, sports, paused] = await a.listMarkets({ limit: 3 });
    assert.equal(a.estimateTakerFeeUsd(100, 0.5, free), 0);
    assert.equal(a.estimateTakerFeeUsd(100, 0.5, sports), 1.25);
    assert.equal(a.estimateTakerFeeUsd(100, 0.5, undefined), 1.25, "unknown schedule assumes the 5% general rate");
    assert.equal(paused.status, "closed", "a market not accepting orders has stale quotes");
    assert.equal(paused.yesBid, undefined);
  } finally {
    globalThis.fetch = real;
  }
});

test("one settled leg of an open arb isn't a realized loss, and turning arbitrage off still closes it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-arb2-"));
  const rules = path.join(dir, "rules.yaml");
  const write = (enabled: boolean) =>
    writeFile(
      rules,
      `rules:\n  - id: noop\n    name: noop\n    filters: { keywords_any: [zzzz] }\narbitrage:\n  enabled: ${enabled}\n  cross_platform: { auto_match: false }\n  same_platform: { enabled: false }\n  unwind_early: false\n`,
    );
  await write(true);
  await writeFile(path.join(dir, "arb-pairs.yaml"), `confirmed:\n  - { kalshi: K1, polymarket: P1 }\n`);
  const open = (id: string, b: number, a: number, platform: PlatformId) => ({ ...mk(platform, id, b, a), closesInHours: 100 });
  const s1 = path.join(dir, "s1.json");
  await writeFile(s1, JSON.stringify([open("K1", 0.4, 0.41, "kalshi"), open("P1", 0.46, 0.47, "polymarket")]));
  // Kalshi settles NO first (our YES leg loses); Polymarket is still trading.
  const s2 = path.join(dir, "s2.json");
  await writeFile(s2, JSON.stringify([{ platform: "kalshi", id: "K1", title: "K1", yesPrice: 0, status: "resolved", resolvedOutcome: "no", closesInHours: -1 }, open("P1", 0.02, 0.03, "polymarket")]));
  const s3 = path.join(dir, "s3.json");
  await writeFile(s3, JSON.stringify([{ platform: "kalshi", id: "K1", title: "K1", yesPrice: 0, status: "resolved", resolvedOutcome: "no", closesInHours: -2 }, { platform: "polymarket", id: "P1", title: "P1", yesPrice: 0, status: "resolved", resolvedOutcome: "no", closesInHours: -1 }]));
  const ledgerPath = path.join(dir, "ledger.json");
  const run = (fixture: string, now: Date) =>
    runPaperCycle({
      rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined,
      adapters: (["kalshi", "polymarket"] as const).map((id) => new DemoAdapter(id, { fixturePath: fixture, now: () => now })),
    });
  await run(s1, NOW);
  await run(s2, new Date(NOW.getTime() + 3600_000));
  const { loadLedger, riskStateFromLedger, summarizeLedger } = await import("../ledger/paper.js");
  let ledger = await loadLedger(ledgerPath, { demo: true });
  const rs = riskStateFromLedger(ledger, "arbitrage", new Date(NOW.getTime() + 3600_000));
  assert.equal(rs.dayPnlUsd, 0, "half-settled arb doesn't count toward the daily loss cap");
  assert.equal(summarizeLedger(ledger).total.realizedPnlUsd, 0);

  await write(false); // strategy switched off with an arb still open
  const r3 = await run(s3, new Date(NOW.getTime() + 7200_000));
  assert.equal(r3.arb?.closed, 1, "open arbs are still settled and scored");
  ledger = await loadLedger(ledgerPath, { demo: true });
  const g = Object.values(ledger.arbGroups ?? {})[0];
  assert.equal(g.status, "closed");
  assert.ok((g.realizedPnlUsd ?? 0) > 0, "NO on Polymarket paid out: the pair made money overall");
});
