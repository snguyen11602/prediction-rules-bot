import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { stringify } from "yaml";
import { RuleSchema, type Rule } from "../rules/schema.js";
import type { NormalizedMarket } from "../types.js";
import type { HistMarket, HistPoint, HistorySet } from "./history.js";
import { lastAtOrBefore, ReplayAdapter } from "./replay.js";
import { forBacktest, runBacktest } from "./run.js";
import { runRound } from "../league/evolve.js";
import { activeMembers, leaguePathFor, leagueRules, loadLeague } from "../league/league.js";
import { runPaperCycle } from "../engine/paper-session.js";

const H = 3600;
const NOW = new Date("2026-10-20T00:00:00Z");
const nowS = NOW.getTime() / 1000;

/** A Kalshi market with hourly points from `fromH` to `toH` hours before NOW; price(h) gives the YES mid. */
function market(id: string, fromH: number, closeH: number, price: (hoursAgo: number) => number, result?: "yes" | "no"): HistMarket {
  const points: HistPoint[] = [];
  for (let h = fromH; h >= Math.max(0, closeH); h--) {
    const mid = price(h);
    points.push([nowS - h * H, Math.round((mid - 0.005) * 1000) / 1000, Math.round((mid + 0.005) * 1000) / 1000, 5000, 20000]);
  }
  const m: NormalizedMarket = {
    platform: "kalshi",
    id,
    title: `Team ${id} wins`,
    yesPrice: price(fromH),
    closesAt: new Date((nowS - closeH * H) * 1000).toISOString(),
    eventId: `EV-${id}`,
  };
  return { market: m, points, result: result ? { outcome: result, at: m.closesAt! } : undefined };
}

test("replay never looks ahead and settles at the close", async () => {
  const h = market("A", 10, 2, (ago) => (ago > 5 ? 0.4 : 0.6), "yes");
  assert.equal(lastAtOrBefore(h.points, nowS - 7 * H - 1)?.[0], nowS - 8 * H);
  let t = new Date((nowS - 6 * H) * 1000);
  const ad = new ReplayAdapter("kalshi", [h], () => t);
  let m = await ad.getMarket("A");
  assert.equal(m?.status, "open");
  assert.ok(Math.abs(m!.yesPrice - 0.4) < 1e-9, "the drop 5h ago isn't visible 6h ago");
  assert.equal(m?.liquidityUsd, 20000);
  t = new Date((nowS - 3 * H) * 1000);
  m = await ad.getMarket("A");
  assert.ok(Math.abs(m!.yesPrice - 0.6) < 1e-9);
  t = new Date((nowS - 1 * H) * 1000);
  m = await ad.getMarket("A");
  assert.equal(m?.status, "resolved");
  assert.equal(m?.resolvedOutcome, "yes");
  assert.equal((await ad.listMarkets()).length, 0, "resolved markets aren't listed");
  // Before its first price, a market doesn't exist yet.
  t = new Date((nowS - 20 * H) * 1000);
  assert.equal(await ad.getMarket("A"), null);
});

test("stale quotes disappear instead of being traded on", async () => {
  const h = market("B", 30, -48, () => 0.5);
  h.points = h.points.filter((p) => p[0] <= nowS - 20 * H); // prices stop 20h ago
  const t = new Date((nowS - 10 * H) * 1000);
  const m = await new ReplayAdapter("kalshi", [h], () => t).getMarket("B");
  assert.equal(m?.status, "open");
  assert.equal(m?.yesBid, undefined);
  assert.equal(m?.yesAsk, undefined);
});

test("quick-move rules compare hour to hour in a backtest", () => {
  const r = RuleSchema.parse({ id: "q", name: "q", action: "alert", entry: { side: "against_move", yes_price_move_abs: 0.03, max_prior_age_minutes: 15 } });
  const b = forBacktest(r, 60);
  assert.equal(b.entry.max_prior_age_minutes, 90);
  assert.equal(b.action, "paper");
  assert.equal(forBacktest({ ...r, entry: { ...r.entry, max_prior_age_minutes: 240 } }, 60).entry.max_prior_age_minutes, 240);
});

/** Ten favorites that drift up and win, half of them inside the held-out last part. */
function favorites(days: number): HistorySet {
  const markets: HistMarket[] = [];
  for (let i = 0; i < 10; i++) {
    // Listed one after another and closing over the window, so some are bought in the last part.
    const start = days * 24 - i * 8;
    const close = Math.round((days * 24 * (9 - i)) / 10) + 2;
    markets.push(market(`F${i}`, start, close, (ago) => Math.min(0.95, 0.84 + (start - ago) * 0.0002), "yes"));
  }
  return { from: new Date(NOW.getTime() - days * 86_400_000).toISOString(), to: NOW.toISOString(), markets };
}

const FAVORITE: Rule = RuleSchema.parse({
  id: "fav",
  name: "Favorites to the finish",
  action: "paper",
  filters: { min_price: 0.8, max_price: 0.94 },
  entry: { side: "yes" },
  risk: { position_size_fraction: 0.05, bankroll_usd: 1000, max_position_usd: 50, max_open_positions: 10, reentry_cooldown_hours: 0 },
  paper: { slippage: 0.005, include_fees: true },
});

test("a backtest replays the paper engine and scores the whole window and the test part", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-bt-"));
  const res = await runBacktest({
    rules: [FAVORITE],
    workDir: path.join(dir, "run"),
    cacheDir: path.join(dir, "cache"),
    days: 4,
    stepMinutes: 60,
    testShare: 0.3,
    perPlatform: 10,
    minTrades: 5,
    now: NOW,
    history: favorites(4),
    platforms: ["kalshi"],
  });
  const r = res.results.get("fav")!;
  assert.equal(res.markets.kalshi, 10);
  assert.equal(res.steps, 4 * 24 + 1);
  assert.ok(r.all.trades >= 9, `traded ${r.all.trades}`);
  assert.ok(r.all.pnlUsd > 0, "favorites that win pay out");
  assert.equal(r.all.exits.resolved, r.all.trades);
  assert.ok(r.all.feesUsd > 0, "fees are charged");
  assert.ok(r.test.trades >= 1 && r.test.trades < r.all.trades);
  assert.ok(r.all.ranked);
});

test("a league round: roster, backtest, clones of the best, diagnosis for the worst", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-league-"));
  const rulesPath = path.join(dir, "rules.yaml");
  const ledgerPath = path.join(dir, "data", "paper-ledger.json");
  await writeFile(
    rulesPath,
    stringify({
      version: 1,
      rules: [FAVORITE],
      // Dip hunters never trade flat prices, so they're the ones to retire.
      league: { roster_size: 4, families: ["dip_buyer"], winners: 1, clones_per_winner: 1, retire: 2, min_trades: 5 },
    }),
  );
  const { league, summary } = await runRound({ rulesPath, ledgerPath, now: NOW, seed: 5, history: favorites(4), days: 4 });
  assert.equal(summary.round, 1);
  assert.equal(summary.standings[0].id, "fav", "your winning rule tops the table");
  assert.equal(summary.champion?.id, "fav");
  assert.equal(summary.retired.length, 2);
  for (const m of summary.retired) {
    assert.equal(m.status, "retired");
    assert.match(m.diagnosis!.headline, /Never found a trade/);
  }
  assert.equal(summary.cloned.length, 1);
  const kid = summary.cloned[0];
  assert.equal(kid.parentId, "fav");
  assert.equal(kid.family, "custom");
  assert.equal(kid.rule.entry.side, "yes", "a clone keeps its parent's idea");
  assert.equal(activeMembers(league).length, 4, "the roster is topped back up");
  assert.ok(league.lastRun?.house.fav.all.pnlUsd);
  assert.ok(league.events.some((e) => e.kind === "cloned") && league.events.some((e) => e.kind === "retired"));
  assert.ok(league.nextRoundAt && Date.parse(league.nextRoundAt) > NOW.getTime());

  // The paper session runs the new roster next to your rules.
  const saved = await loadLeague(leaguePathFor(ledgerPath));
  assert.equal(saved.members.length, league.members.length);
  assert.equal(leagueRules(saved, undefined).filter((r) => r.enabled).length, 4);
  const t = new Date(NOW.getTime() - 30 * 3600_000);
  const res = await runPaperCycle({
    rulesPath,
    ledgerPath,
    now: t,
    adapters: [new ReplayAdapter("kalshi", favorites(4).markets, () => t)],
    emit: async () => undefined,
  });
  const ids = new Set(res.trace?.rules.map((r) => r.ruleId));
  for (const m of activeMembers(saved)) assert.ok(ids.has(m.id), `${m.name} is checked by the paper session`);
  assert.ok(ids.has("fav"));
});
