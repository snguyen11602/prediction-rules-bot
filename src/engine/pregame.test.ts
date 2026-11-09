import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { RuleSchema } from "../rules/schema.js";
import { priceAt, traceEntry } from "./evaluate.js";
import { candlesToTicks } from "../platforms/kalshi.js";
import { DemoAdapter } from "../platforms/demo.js";
import { clearHourlyCache, loadHourly } from "./pregame.js";
import { runPaperCycle } from "./paper-session.js";
import { isGame } from "./games.js";
import type { PaperLedger } from "../ledger/paper.js";
import type { NormalizedMarket } from "../types.js";
import type { Tick } from "./series.js";

const NOW = new Date("2026-11-10T22:00:00Z");
const H = 3600_000;
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
  resolvesAt: new Date(NOW.getTime() + 5 * H).toISOString(),
  ...over,
});
const hourly = (from: number, to: number): Tick[] => [
  { t: NOW.getTime() - 12 * H, p: from, s: 0.02 },
  { t: NOW.getTime() - 10 * H, p: from, s: 0.02 },
  { t: NOW.getTime() - 1 * H, p: to, s: 0.02 },
];
const rule = (entry: Record<string, unknown> = {}) =>
  RuleSchema.parse({
    id: "late",
    name: "late",
    action: "paper",
    filters: { platforms: ["kalshi"], market_types: ["game_winner"], min_price: 0.3, max_price: 0.95, pre_game_only: true },
    entry: { side: "yes", pregame_move: {}, ...entry },
    risk: { fire_after_n_losses: 0 },
  });
const last = (r: ReturnType<typeof traceEntry>) => r.checks.find((c) => c.name === "Pre-game move")!;

test("pre-game move: buys the side that rose 2¢+ over the last 10 hours, only in the last 3 hours before the start", () => {
  const up = traceEntry(rule(), game(), undefined, NOW, { hourly: hourly(0.55, 0.59) });
  assert.equal(up.match?.side, "yes");
  assert.match(last(up).detail, /\+5¢ in 10h \(55¢ → 60¢\), starts in 2h/);
  // Not enough of a rise, a drop, too early, already started, no history.
  assert.match(last(traceEntry(rule(), game(), undefined, NOW, { hourly: hourly(0.59, 0.6) })).detail, /needs ≥ 2¢/);
  assert.match(last(traceEntry(rule(), game(), undefined, NOW, { hourly: hourly(0.66, 0.61) })).detail, /needs a rise/);
  assert.match(last(traceEntry(rule(), game({ startsAt: new Date(NOW.getTime() + 5 * H).toISOString() }), undefined, NOW, { hourly: hourly(0.5, 0.6) })).detail, /only buys in the last 3h/);
  assert.equal(traceEntry(rule(), game({ startsAt: new Date(NOW.getTime() - H).toISOString() }), undefined, NOW, { hourly: hourly(0.5, 0.6) }).match, null);
  assert.match(last(traceEntry(rule(), game(), undefined, NOW, {})).detail, /no trustworthy price from 10h ago/);
  assert.match(last(traceEntry(rule(), game({ startsAt: undefined }), undefined, NOW, { hourly: hourly(0.5, 0.6) })).detail, /not a game/);
});

test("pre-game move: an earlier price from a wide book isn't trusted; with_move buys NO after a drop; own snapshots work too", () => {
  const wide: Tick[] = [{ t: NOW.getTime() - 10 * H, p: 0.5, s: 0.2 }];
  assert.equal(priceAt(wide, NOW.getTime() - 10 * H, 2 * H, 0.05), undefined);
  assert.equal(traceEntry(rule(), game(), undefined, NOW, { hourly: wide }).match, null);
  // A price from long before the lookback isn't "10 hours ago".
  assert.equal(priceAt([{ t: NOW.getTime() - 20 * H, p: 0.5 }], NOW.getTime() - 10 * H, 2 * H), undefined);
  const down = traceEntry(rule({ side: "with_move" }), game(), undefined, NOW, { hourly: hourly(0.66, 0.61) });
  assert.equal(down.match?.side, "no");
  // No platform history: the bot's own snapshots are used.
  assert.equal(traceEntry(rule(), game(), undefined, NOW, { series: hourly(0.55, 0.59) }).match?.side, "yes");
  // A "move" of nothing isn't a signal.
  assert.throws(() => RuleSchema.parse({ id: "x", name: "x", entry: { pregame_move: { min_move: 0 } } }));
});

test("Kalshi hourly candles become mid prices; hours with no real two-sided quote are dropped", () => {
  const ticks = candlesToTicks([
    { end_period_ts: 200, yes_bid: { close_dollars: "0.60" }, yes_ask: { close_dollars: "0.62" } },
    { end_period_ts: 100, yes_bid: { close_dollars: "0.50" }, yes_ask: { close_dollars: "0.54" } },
    { end_period_ts: 300, yes_bid: { close_dollars: "0.00" }, yes_ask: { close_dollars: "1.00" } },
    { end_period_ts: 400, yes_ask: { close_dollars: "0.70" } },
  ]);
  assert.deepEqual(ticks.map((t) => [t.t, +t.p.toFixed(2), +t.s!.toFixed(2)]), [[100_000, 0.52, 0.04], [200_000, 0.61, 0.02]]);
});

test("what counts as a game: match tickers and game slugs, not crypto or politics", () => {
  assert.ok(isGame({ platform: "kalshi", id: "KXATPMATCH-26NOV09BORSAM-SAM" }));
  assert.ok(isGame({ platform: "kalshi", id: "KXNBASPREAD-26NOV08PHICHI-PHI5" }));
  assert.ok(!isGame({ platform: "kalshi", id: "KXBTC15M-26NOV091430-30" }));
  assert.ok(!isGame({ platform: "kalshi", id: "SENATEMS-26-R" }));
  assert.ok(isGame({ platform: "polymarket_us", id: "1", raw: { slug: "aec-nba-lal-atl-2026-11-09" } }));
  assert.ok(!isGame({ platform: "polymarket_us", id: "2", raw: { slug: "ewc-usse-ak-2026-11-03-rep" }, startsAt: "2026-11-03T17:00:00Z" }));
});

class HistoryDemo extends DemoAdapter {
  calls = 0;
  constructor(fixturePath: string, now: () => Date, private readonly hist: Record<string, Tick[]>) {
    super("kalshi", { fixturePath, now });
  }
  async priceHistory(ids: string[]): Promise<Map<string, Tick[]>> {
    this.calls++;
    return new Map(ids.filter((id) => this.hist[id]).map((id) => [id, this.hist[id]]));
  }
}

test("paper: the late-mover rule buys the riser once per game, from the platform's hourly prices (fetched once, then cached)", async () => {
  clearHourlyCache();
  const dir = await mkdtemp(path.join(tmpdir(), "prb-late-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: late
    name: Late movers
    action: paper
    filters: { platforms: [kalshi], market_types: [game_winner], min_price: 0.3, max_price: 0.95, max_spread: 0.05, pre_game_only: true }
    entry: { side: yes, pregame_move: { min_move: 0.02, lookback_hours: 10, max_hours_to_start: 3 } }
    risk: { fire_after_n_losses: 0, max_position_usd: 25, position_size_fraction: 0.025 }
`,
  );
  const fixture = path.join(dir, "k.json");
  const bos = game();
  const nyk = game({ id: "KXNBAGAME-26NOV10BOSNYK-NYK", title: "New York wins", yesPrice: 0.4, yesBid: 0.39, yesAsk: 0.41 });
  const far = game({ id: "KXNBAGAME-26NOV11LALGSW-LAL", eventId: "KXNBAGAME-26NOV11LALGSW", title: "LA wins", startsAt: new Date(NOW.getTime() + 20 * H).toISOString() });
  await writeFile(fixture, JSON.stringify([bos, nyk, far]));
  const adapter = new HistoryDemo(fixture, () => NOW, { [bos.id]: hourly(0.55, 0.59), [nyk.id]: hourly(0.45, 0.41), [far.id]: hourly(0.5, 0.6) });
  const ledgerPath = path.join(dir, "ledger.json");
  const run = (now: Date) => runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [adapter] });
  const r = await run(NOW);
  assert.equal(r.opened, 1);
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.equal(ledger.positions[0].marketId, bos.id);
  assert.equal(ledger.positions[0].side, "yes");
  assert.ok(ledger.positions[0].costUsd <= 25);
  assert.equal(adapter.calls, 1);
  // Five minutes later: nothing new (already in this game), and no second history request.
  assert.equal((await run(new Date(NOW.getTime() + 300_000))).opened, 0);
  assert.equal(adapter.calls, 1);
  // The loader only asks for games inside the rule's window.
  clearHourlyCache();
  const got = await loadHourly([rule()], [bos, far], () => adapter, NOW);
  assert.deepEqual([...got.keys()], [`kalshi:${bos.id}`]);
});
