import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuleSchema } from "../rules/schema.js";
import { checkEntryRisk, defaultRiskState, rewardRisk, worstLossFraction } from "./risk.js";
import { alertKind, alertRequest, alertSink, alertSinkFromEnv, parseAlertKinds } from "./notify.js";
import { backfillStarts, closingLine, closingStats, finalizeClosings, noteClosing, startTracking } from "./closing.js";
import { runPaperCycle } from "./paper-session.js";
import { DemoAdapter } from "../platforms/demo.js";
import { summarizeLedger, type PaperLedger, type PaperPosition } from "../ledger/paper.js";
import type { EngineEvent, NormalizedMarket } from "../types.js";
import type { Tick } from "./series.js";

const NOW = new Date("2026-11-10T22:00:00Z");
const H = 3600_000;
const rule = (risk: Record<string, unknown>, exit?: Record<string, unknown>) =>
  RuleSchema.parse({ id: "r", name: "r", action: "paper", exit, risk: { position_size_fraction: 0.05, bankroll_usd: 1000, max_position_usd: 50, ...risk } });
const size = (r: ReturnType<typeof rule>, price?: number) => checkEntryRisk(r, defaultRiskState("d"), NOW, price);

test("max loss per trade: the size is cut so the worst case fits", () => {
  // Held to the result: the whole stake can be lost, so the stake is the cap.
  const hold = size(rule({ max_loss_per_trade_usd: 20 }), 0.9);
  assert.equal(hold.sizeUsd, 20);
  assert.match(hold.checks.at(-1)!.detail, /cut to \$20 so the most it can lose is \$20 ≤ \$20 \(no stop loss/);
  // A 30% stop is sized as a 45% loss (stops often fill worse): $20 / 0.45 = $44.44.
  const stop = size(rule({ max_loss_per_trade_usd: 20 }, { stop_loss_pct: 0.3 }), 0.6);
  assert.equal(+stop.sizeUsd!.toFixed(2), 44.44);
  // A stop price: bought at 60¢, stop at 45¢ = −25%, sized for −37.5% → $53 > the $50 normal size, so unchanged.
  const price = size(rule({ max_loss_per_trade_usd: 20 }, { stop_loss_price: 0.45 }), 0.6);
  assert.equal(price.sizeUsd, 50);
  assert.match(price.checks.at(-1)!.detail, /already within/);
  // A very wide stop never counts as more than the stake.
  assert.equal(worstLossFraction({ stop_loss_pct: 0.9 }, 0.5).fraction, 1);
  // No cap set: nothing changes.
  assert.equal(size(rule({}), 0.9).sizeUsd, 50);
});

test("reward vs risk: a trade that can't win enough for what it can lose is skipped", () => {
  // 90¢ held to the result: gain 10¢, lose 90¢ → 0.11.
  assert.equal(+rewardRisk(undefined, 0.9).toFixed(2), 0.11);
  const fav = size(rule({ min_reward_risk: 1 }), 0.9);
  assert.equal(fav.ok, false);
  assert.match(fav.checks.at(-1)!.detail, /could gain 0\.11× what it could lose < 1×/);
  // 40¢ with a 25% stop (sized as 37.5%) and a 70¢ target: gain 30¢, lose 15¢ → 2.
  assert.equal(+rewardRisk({ stop_loss_pct: 0.25, take_profit_price: 0.7 }, 0.4).toFixed(2), 2);
  assert.equal(size(rule({ min_reward_risk: 1.5 }, { stop_loss_pct: 0.25, take_profit_price: 0.7 }), 0.4).ok, true);
});

const ev = (type: EngineEvent["type"], message: string, ruleId = "late-mover-paper"): EngineEvent => ({ at: NOW.toISOString(), type, ruleId, message, market: { platform: "kalshi", id: "X", title: "Buffalo wins", yesPrice: 0.6 } });

test("phone alerts: trades, exits and pauses by default; shaped for Discord, Slack, ntfy; rate limited", async () => {
  assert.equal(alertKind(ev("paper_fill", "x")), "trades");
  assert.equal(alertKind(ev("arb_close", "x")), "exits");
  assert.equal(alertKind(ev("risk_block", "Consecutive-loss pause armed until …")), "pauses");
  assert.equal(alertKind(ev("risk_block", "max open positions")), undefined);
  assert.equal(alertKind(ev("info", "x")), undefined);
  assert.deepEqual(parseAlertKinds("exits, signals"), ["exits", "signals"]);
  assert.deepEqual(parseAlertKinds("nonsense"), ["trades", "exits", "pauses"]);
  assert.deepEqual(JSON.parse(alertRequest("https://discord.com/api/webhooks/1/abc", "hi").body), { content: "hi" });
  assert.deepEqual(JSON.parse(alertRequest("https://hooks.slack.com/services/T/B/x", "hi").body), { text: "hi" });
  assert.equal(alertRequest("https://ntfy.sh/my-topic", "hi").body, "hi");
  assert.deepEqual(JSON.parse(alertRequest("https://example.com/hook", "hi").body), { text: "hi", content: "hi" });

  const sent: string[] = [];
  let t = 0;
  const sink = alertSink("https://discord.com/api/webhooks/1/abc", { maxPer10Min: 2, now: () => t, post: async (_u, init) => (sent.push(JSON.parse(init.body).content), { ok: true, status: 204 }) });
  await sink(ev("paper_fill", "Paper fill YES 39 @ 0.640 = $24.96"));
  await sink(ev("entry_signal", "signal")); // not a default kind
  await sink(ev("paper_exit", "Paper exit +$4.10"));
  await sink(ev("paper_fill", "third"));
  await sink(ev("paper_fill", "fourth"));
  assert.equal(sent.length, 2);
  assert.match(sent[0], /^PAPER TRADE · late-mover-paper\nPaper fill YES 39 @ 0\.640 = \$24\.96 — Buffalo wins$/);
  t = 11 * 60_000;
  await sink(ev("paper_exit", "later"));
  assert.match(sent[2], /\(\+2 earlier alerts not sent: too many at once\)/);
});

test("phone alerts: only chosen strategies; a failed send never prints the webhook address", async () => {
  const sent: string[] = [];
  const only = alertSink("https://example.com/h", { rules: ["arbitrage"], post: async (_u, init) => (sent.push(init.body), { ok: true, status: 200 }) });
  await only(ev("paper_fill", "x"));
  await only(ev("arb_open", "ARB opened", "arbitrage"));
  assert.equal(sent.length, 1);
  const errors: string[] = [];
  const secret = "https://discord.com/api/webhooks/123/SECRET-TOKEN";
  const failing = alertSink(secret, { onError: (m) => errors.push(m), post: async () => { throw new Error(`fetch failed ${secret}`); } });
  await failing(ev("paper_fill", "x"));
  const refused = alertSink(secret, { onError: (m) => errors.push(m), post: async () => ({ ok: false, status: 404 }) });
  await refused(ev("paper_fill", "x"));
  assert.equal(errors.length, 2);
  assert.ok(errors.every((m) => !m.includes("SECRET")));
  assert.equal(alertSinkFromEnv({}), undefined);
  assert.equal(alertSinkFromEnv({ ALERT_WEBHOOK_URL: "not a url" }), undefined);
  assert.equal(typeof alertSinkFromEnv({ ALERT_WEBHOOK_URL: "https://ntfy.sh/t" }), "function");
});

const game = (over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform: "kalshi",
  id: "KXNBAGAME-26NOV10BOSNYK-BOS",
  eventId: "KXNBAGAME-26NOV10BOSNYK",
  title: "Boston wins",
  yesPrice: 0.6,
  yesBid: 0.59,
  yesAsk: 0.61,
  marketType: "game_winner",
  startsAt: new Date(NOW.getTime() + 2 * H).toISOString(),
  ...over,
});
const position = (over: Partial<PaperPosition> = {}): PaperPosition => ({
  id: "p1", ruleId: "r", platform: "kalshi", marketId: "KXNBAGAME-26NOV10BOSNYK-BOS", title: "Boston wins", side: "yes", status: "open",
  entryAt: NOW.toISOString(), entryPrice: 0.61, contracts: 40, costUsd: 24.4, entryFeeUsd: 0.67, hypothetical: true, ...over,
});
const ledgerOf = (positions: PaperPosition[]): PaperLedger => ({ version: 2, createdAt: NOW.toISOString(), positions, fills: [], ruleState: {}, lastPrices: {} }) as unknown as PaperLedger;

test("closing price: the last check before the start, kept for bets on games placed before they start", async () => {
  const pos = position();
  startTracking(pos, game(), NOW);
  assert.equal(pos.startsAt, game().startsAt);
  // Not a game, or already started: not tracked.
  const none = position();
  startTracking(none, game({ id: "KXBTC15M-26NOV091430-30", marketType: "other" }), NOW);
  startTracking(none, game({ startsAt: new Date(NOW.getTime() - H).toISOString() }), NOW);
  assert.equal(none.startsAt, undefined);
  // Checks before the start update it; a wide book doesn't count; a NO bet tracks the NO price.
  noteClosing(pos, game({ yesBid: 0.64, yesAsk: 0.66 }), new Date(NOW.getTime() + 1.9 * H));
  noteClosing(pos, game({ yesBid: 0.3, yesAsk: 0.9 }), new Date(NOW.getTime() + 1.95 * H));
  assert.equal(+pos.closing!.price.toFixed(2), 0.65);
  const no = position({ side: "no", entryPrice: 0.41, startsAt: pos.startsAt });
  noteClosing(no, game({ yesBid: 0.64, yesAsk: 0.66 }), new Date(NOW.getTime() + 1.9 * H));
  assert.equal(+no.closing!.price.toFixed(2), 0.35);
  // After the start that check (6 minutes before) is final: bought at 61¢, closed at 65¢ = beat it by 4¢.
  const ledger = ledgerOf([pos, no]);
  assert.equal(await finalizeClosings(ledger, () => undefined, new Date(NOW.getTime() + 2.1 * H)), 2);
  assert.ok(pos.closing!.final);
  noteClosing(pos, game({ yesBid: 0.2, yesAsk: 0.22 }), new Date(NOW.getTime() + 2.2 * H));
  assert.equal(+pos.closing!.price.toFixed(2), 0.65, "in-play prices never overwrite it");
  const stats = closingStats(ledger.positions);
  assert.deepEqual([stats.n, stats.beat, +stats.avg.toFixed(3)], [2, 1, -0.01]);
  assert.equal(closingLine(stats), "−1.0¢ vs the close, beat it 1 of 2");
  assert.equal(closingLine(undefined), "no closing prices yet");
  assert.deepEqual(summarizeLedger(ledger).total.clv, { n: 2, avg: -0.01, beat: 1 });
});

test("closing price: a sleeping laptop still gets one from the platform's hourly prices; old bets are picked up once", async () => {
  const start = NOW.getTime() + 2 * H;
  const hist: Tick[] = [{ t: start - 1.5 * H, p: 0.6, s: 0.02 }, { t: start - 0.5 * H, p: 0.66, s: 0.02 }, { t: start + 0.5 * H, p: 0.9, s: 0.02 }];
  const adapter = {
    id: "kalshi" as const,
    listMarkets: async () => [],
    getMarkets: async () => [game()],
    priceHistory: async (ids: string[]) => new Map(ids.map((id) => [id, hist])),
  };
  // Last seen 3 hours before the start (stale), then nothing until after the game began.
  const asleep = position({ startsAt: new Date(start).toISOString(), closing: { price: 0.58, at: new Date(start - 3 * H).toISOString(), source: "check" } });
  const sold = position({ id: "p2", status: "closed", startsAt: new Date(start).toISOString() });
  const ledger = ledgerOf([asleep, sold]);
  await finalizeClosings(ledger, () => adapter, new Date(start + H));
  assert.deepEqual([asleep.closing!.source, +asleep.closing!.price.toFixed(2), asleep.closing!.final], ["hourly", 0.66, true]);
  assert.equal(+sold.closing!.price.toFixed(2), 0.66, "a bet sold before the start still gets its closing price");
  // No history and no recent check: given up on after six hours, not retried forever.
  const lost = position({ startsAt: new Date(start).toISOString() });
  await finalizeClosings(ledgerOf([lost]), () => undefined, new Date(start + H));
  assert.equal(lost.closingMissed, undefined);
  await finalizeClosings(ledgerOf([lost]), () => undefined, new Date(start + 7 * H));
  assert.equal(lost.closingMissed, true);
  // A bet from before this feature: its start time is looked up once.
  const old = position();
  const inPlay = position({ id: "p3", entryAt: new Date(start + H).toISOString() });
  const L = ledgerOf([old, inPlay]);
  await backfillStarts(L, () => adapter, new Date(start + 2 * H));
  assert.equal(old.startsAt, new Date(start).toISOString());
  assert.equal(inPlay.closingMissed, true, "bought after the start: no closing price to beat");
});

test("paper: a bet's closing price is recorded as the game starts", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-close-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(rules, `rules:\n  - id: buyer\n    name: Buyer\n    action: paper\n    filters: { platforms: [kalshi], pre_game_only: true }\n    entry: { side: yes, yes_price_above: 0.5 }\n    risk: { fire_after_n_losses: 0 }\n`);
  const fixture = path.join(dir, "k.json");
  const ledgerPath = path.join(dir, "ledger.json");
  const run = async (now: Date, m: NormalizedMarket) => {
    await writeFile(fixture, JSON.stringify([m]));
    return runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })] });
  };
  assert.equal((await run(NOW, game())).opened, 1);
  await run(new Date(NOW.getTime() + 1.95 * H), game({ yesPrice: 0.7, yesBid: 0.69, yesAsk: 0.71 }));
  await run(new Date(NOW.getTime() + 2.05 * H), game({ yesPrice: 0.9, yesBid: 0.89, yesAsk: 0.91 }));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const pos = ledger.positions[0];
  assert.deepEqual([+pos.closing!.price.toFixed(2), pos.closing!.final, pos.closing!.source], [0.7, true, "check"]);
  const s = summarizeLedger(ledger).rules[0].clv!;
  assert.deepEqual([s.n, s.beat, +s.avg.toFixed(2)], [1, 1, 0.09]);
});

// ---------- reset ----------
import http from "node:http";
import type { AddressInfo } from "node:net";
import { readdir } from "node:fs/promises";
import { applyControl, controlsPathFor, emptyControls, loadControls, saveControls } from "./controls.js";
import { loadLedger, resetLedger, withLedgerLock } from "../ledger/paper.js";
import { createDashboardServer } from "../dashboard/server.js";

async function resetSetup() {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-reset-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(rules, `rules:\n  - id: buyer\n    name: Buyer\n    action: paper\n    filters: { platforms: [kalshi] }\n    entry: { side: yes, yes_price_above: 0.5 }\n    risk: { fire_after_n_losses: 0, reentry_cooldown_hours: 0 }\n`);
  const fixture = path.join(dir, "k.json");
  const ledgerPath = path.join(dir, "ledger.json");
  const run = async (now: Date, markets: NormalizedMarket[]) => {
    await writeFile(fixture, JSON.stringify(markets));
    return runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })] });
  };
  return { dir, rules, ledgerPath, run };
}

test("reset: the ledger is archived and a new one starts at zero; nothing is deleted", async () => {
  const s = await resetSetup();
  await s.run(NOW, [game()]);
  const before = await readFile(s.ledgerPath, "utf8");
  assert.equal((JSON.parse(before) as PaperLedger).positions.length, 1);
  const r = await withLedgerLock(s.ledgerPath, () => resetLedger(s.ledgerPath, { demo: true, now: new Date(NOW.getTime() + 60_000) }));
  assert.deepEqual([r.open, r.closed], [1, 0]);
  assert.match(r.archive!, /^archive[\\/]ledger-2026-11-10T22-01-00Z\.json$/);
  assert.equal(await readFile(path.join(s.dir, r.archive!), "utf8"), before, "the backup is the old file, byte for byte");
  const fresh = await loadLedger(s.ledgerPath, { demo: true });
  assert.deepEqual([fresh.positions.length, fresh.fills.length, Object.keys(fresh.ruleState).length], [0, 0, 0]);
  assert.equal(summarizeLedger(fresh).total.realizedPnlUsd, 0);
  // Resetting an empty portfolio makes no backup file.
  const again = await withLedgerLock(s.ledgerPath, () => resetLedger(s.ledgerPath, { demo: true, now: new Date(NOW.getTime() + 120_000) }));
  assert.equal(again.archive, undefined);
  assert.equal((await readdir(path.join(s.dir, "archive"))).length, 1);
});

test("reset from the dashboard: one request, carried out once by the next paper check, and trading goes on", async () => {
  const s = await resetSetup();
  await s.run(NOW, [game()]);
  const file = controlsPathFor(s.ledgerPath);
  await saveControls(file, applyControl({ ...emptyControls(), stopped: { other: "x" } }, { action: "reset" }, new Date(NOW.getTime() + 30_000)));
  const kept = await loadControls(file);
  assert.equal(kept.stopped.other, "x", "switches are untouched");
  assert.equal(kept.resetRequestedAt, new Date(NOW.getTime() + 30_000).toISOString());
  // The next check resets, then trades as usual on the fresh portfolio.
  const other = game({ id: "KXNBAGAME-26NOV10LALGSW-LAL", eventId: "KXNBAGAME-26NOV10LALGSW", title: "LA wins" });
  const r = await s.run(new Date(NOW.getTime() + 60_000), [other]);
  assert.ok(r.events.some((e) => /^Portfolio reset: starting over at \$0\. 0 closed and 1 open paper trade\(s\)/.test(e.message)));
  let ledger = await loadLedger(s.ledgerPath, { demo: true });
  assert.deepEqual(ledger.positions.map((p) => p.marketId), [other.id], "only the trade made after the reset");
  assert.equal(ledger.resetFrom?.request, kept.resetRequestedAt);
  // Later checks don't reset again.
  await s.run(new Date(NOW.getTime() + 120_000), [other]);
  ledger = await loadLedger(s.ledgerPath, { demo: true });
  assert.equal(ledger.positions.length, 1);
  assert.equal((await readdir(path.join(s.dir, "archive"))).length, 1);
});

test("the dashboard's reset only records a request; the page shows it as pending until a check carries it out", async () => {
  const s = await resetSetup();
  await s.run(NOW, [game()]);
  const server = createDashboardServer({ ledgerPath: s.ledgerPath, rulesPath: s.rules, demo: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post = (headers: Record<string, string>) =>
    new Promise<number>((resolve, reject) => {
      const u = new URL(`${base}/api/control`);
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers: { Host: u.host, ...headers } }, (res) => (res.resume(), resolve(res.statusCode ?? 0)));
      req.on("error", reject);
      req.end(JSON.stringify({ action: "reset" }));
    });
  try {
    assert.equal(await post({ "Content-Type": "application/json", Origin: "https://evil.example" }), 403, "another site can't reset it");
    assert.equal(await post({ "Content-Type": "text/plain" }), 415);
    assert.equal(await post({ "Content-Type": "application/json", Origin: base }), 200);
    let state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.ledger.resetPending, true);
    assert.equal(state.open.length, 1, "the ledger itself is untouched until the bot's next check");
    await s.run(new Date(Date.now() + 1000), []);
    state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.ledger.resetPending, false);
    assert.deepEqual([state.open.length, state.totals.closed, state.ledger.resetFrom.open], [0, 0, 1]);
  } finally {
    server.close();
  }
});
