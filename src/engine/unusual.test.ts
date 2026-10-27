import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { detectUnusualMove, type UnusualParams } from "./unusual.js";
import { evaluateEntry } from "./evaluate.js";
import { evaluateExit } from "./exits.js";
import { RuleSchema } from "../rules/schema.js";
import type { Tick } from "./series.js";
import { SeriesStore, loadSeries, saveSeries } from "./series.js";
import { DemoAdapter } from "../platforms/demo.js";
import { runPaperCycle } from "./paper-session.js";
import type { EngineEvent, NormalizedMarket } from "../types.js";
import type { PaperLedger } from "../ledger/paper.js";

const NOW = Date.parse("2026-10-27T18:00:00Z");
const P: UnusualParams = {
  window_minutes: 60,
  lookback_hours: 12,
  min_move: 0.05,
  min_zscore: 3,
  min_volume_ratio: 3,
  max_retrace: 0.35,
  min_history_points: 12,
  direction: "any",
};

/** 12h of quiet ±0.5¢ wiggle every 5 min at `base`, volume growing slowly, then `tail` points (5-min steps). */
function chart(base: number, tail: Array<{ p: number; v?: number }>, opts: { noise?: number; walk?: number; vol?: number } = {}): Tick[] {
  const ticks: Tick[] = [];
  const steps = 144;
  let v = opts.vol ?? 10_000;
  let level = base;
  let seed = 7;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31) * 2 - 1;
  for (let i = 0; i < steps; i++) {
    const t = NOW - (steps + tail.length - 1 - i) * 5 * 60_000;
    if (opts.walk) level = Math.min(0.9, Math.max(0.1, level + rand() * opts.walk)); // genuinely volatile market
    ticks.push({ t, p: level + (i % 2 ? 1 : -1) * (opts.noise ?? 0.005), v });
    v += 30;
  }
  tail.forEach((x, i) => ticks.push({ t: NOW - (tail.length - 1 - i) * 5 * 60_000, p: x.p, v: x.v ?? v }));
  return ticks;
}

const spike = (to: number, extraVol: number) =>
  Array.from({ length: 12 }, (_, i) => ({ p: 0.4 + ((to - 0.4) * (i + 1)) / 12, v: 14_320 + (extraVol * (i + 1)) / 12 }));

test("flags a sharp, high-volume move that holds", () => {
  const r = detectUnusualMove(chart(0.4, spike(0.5, 8000)), NOW, P);
  assert.ok(r.move, r.reason);
  assert.equal(r.move!.direction, "up");
  assert.ok(r.move!.zscore >= 3);
  assert.ok((r.move!.volumeRatio ?? 0) >= 3);
});

test("ignores the same move without a volume spike, after a reversal, or where it's normal", () => {
  assert.match(detectUnusualMove(chart(0.4, spike(0.5, 0)), NOW, P).reason, /no volume spike/);
  const reversed = [...spike(0.5, 8000).slice(0, 8), { p: 0.43, v: 22_000 }, { p: 0.42, v: 22_300 }, { p: 0.42, v: 22_400 }, { p: 0.42, v: 22_500 }];
  assert.match(detectUnusualMove(chart(0.4, reversed), NOW, P).reason, /reversing|too small/);
  // A market that random-walks ±4¢ every 5 minutes: 10¢ in an hour is ordinary for it.
  assert.match(detectUnusualMove(chart(0.4, spike(0.5, 8000), { walk: 0.04 }), NOW, P).reason, /normal for this market/);
  // …but plain bid/ask flicker in a quiet market doesn't count as volatility.
  assert.ok(detectUnusualMove(chart(0.4, spike(0.5, 8000), { noise: 0.02 }), NOW, P).move);
  assert.match(detectUnusualMove(spike(0.5, 8000).map((x, i) => ({ t: NOW - (11 - i) * 300_000, ...x })), NOW, P).reason, /not enough history/);
});

test("rules: require / exclude modes and sides relative to the move", () => {
  const market: NormalizedMarket = { platform: "polymarket", id: "m", title: "Test", yesPrice: 0.3 };
  const down = chart(0.4, spike(0.3, 8000));
  const follow = RuleSchema.parse({ id: "f", name: "f", entry: { unusual_move: {}, side: "with_move" } });
  const fade = RuleSchema.parse({ id: "d", name: "d", entry: { unusual_move: {}, side: "against_move" } });
  const dip = RuleSchema.parse({ id: "x", name: "x", entry: { unusual_move: { mode: "exclude" }, yes_price_move_abs: 0.05, side: "against_move" } });
  const now = new Date(NOW);
  assert.equal(evaluateEntry(follow, market, undefined, now, { series: down })?.side, "no", "follow a drop = buy NO");
  assert.equal(evaluateEntry(fade, market, undefined, now, { series: down })?.side, "yes");
  assert.match(evaluateEntry(follow, market, undefined, now, { series: down })!.reason, /unusual −10(\.5)?¢ in 60m \(\d+(\.\d)?σ, volume/);
  assert.equal(evaluateEntry(follow, market, undefined, now, { series: [] }), null, "no history → no signal");
  // Dip-buying stays out of an informed-looking drop, but buys an ordinary one.
  const prior = { yesPrice: 0.4, at: new Date(NOW - 300_000).toISOString() };
  assert.equal(evaluateEntry(dip, market, prior, now, { series: down }), null);
  assert.equal(evaluateEntry(dip, market, prior, now, { series: chart(0.4, spike(0.3, 0)) })?.side, "yes");
  // Not enough history to tell → the dip rule stays out by default…
  assert.equal(evaluateEntry(dip, market, prior, now, { series: [] }), null);
  const lenient = RuleSchema.parse({ id: "y", name: "y", entry: { unusual_move: { mode: "exclude", on_missing_data: "allow" }, yes_price_move_abs: 0.05, side: "against_move" } });
  assert.equal(evaluateEntry(lenient, market, prior, now, { series: [] })?.side, "yes", "…unless told to allow it");
});

test("review fixes: history gaps, zero-volume baselines, flat markets", () => {
  // Bot was off for 3h while the price drifted up: not a 60-minute move.
  const quiet = chart(0.5, []).filter((t) => t.t <= NOW - 3 * 3600_000);
  const gap = [...quiet, { t: NOW - 60_000, p: 0.58, v: 20_000 }, { t: NOW, p: 0.58, v: 20_100 }];
  assert.match(detectUnusualMove(gap, NOW, P).reason, /gap in price history/);
  // A market whose 24h volume was ~0 isn't "99× normal" after one trade.
  const dead = chart(0.4, spike(0.5, 500), { vol: 0 }).map((t) => ({ ...t, v: t.v! < 5000 ? 0 : t.v }));
  assert.notEqual(detectUnusualMove(dead.map((t, i) => ({ ...t, v: i < dead.length - 12 ? 0 : 400 })), NOW, P).move?.volumeRatio, 99);
  // A perfectly flat market with every threshold at 0 has no "move".
  const flat = chart(0.4, [{ p: 0.395 }], { noise: 0 }).map((t) => ({ ...t, p: 0.4 }));
  assert.equal(detectUnusualMove(flat, NOW, { ...P, min_move: 0, min_zscore: 0, min_volume_ratio: 0 }).move, undefined);
});

test("rules file rejects side: with_move with nothing to follow", async () => {
  const { RulesFileSchema } = await import("../rules/schema.js");
  const r = RulesFileSchema.safeParse({ rules: [{ id: "a", name: "a", entry: { side: "with_move" } }] });
  assert.equal(r.success, false);
});

test("trailing stop: a no-bid mid never raises the high", async () => {
  const { emptyLedger, openPosition, markPosition } = await import("../ledger/paper.js");
  const l = emptyLedger(true);
  const pos = openPosition(l, { ruleId: "r", platform: "kalshi", marketId: "m", title: "m", side: "yes", price: 0.5, sizeUsd: 50 });
  markPosition(pos, 0.5, new Date());
  markPosition(pos, 0.57, new Date(), "open", { tradable: false });
  assert.equal(pos.peakMarkPrice, 0.5);
  const m: NormalizedMarket = { platform: "kalshi", id: "m", title: "m", yesPrice: 0.53 };
  assert.equal(evaluateExit({ trailing_stop: 0.04, trailing_activation: 0.03 }, pos, m, 0.53, new Date()), null);
});

test("trailing stop sells after a pullback from the high, once activated", () => {
  const exit = { trailing_stop: 0.04, trailing_activation: 0.03 };
  const m: NormalizedMarket = { platform: "kalshi", id: "k", title: "t", yesPrice: 0.5 };
  const pos = (peak: number) => ({ entryAt: new Date(NOW).toISOString(), entryPrice: 0.5, peakMarkPrice: peak });
  assert.equal(evaluateExit(exit, pos(0.52), m, 0.47, new Date(NOW)), null, "not armed: high was only +2¢");
  assert.equal(evaluateExit(exit, pos(0.6), m, 0.57, new Date(NOW)), null, "3¢ off the high");
  assert.equal(evaluateExit(exit, pos(0.6), m, 0.56, new Date(NOW))?.reason, "trailing_stop");
});

test("price history persists and is pruned", async () => {
  const s = new SeriesStore({ maxAgeHours: 1, minSpacingSec: 60 });
  const m: NormalizedMarket = { platform: "kalshi", id: "A", title: "a", yesPrice: 0.5, volume24hUsd: 100 };
  s.record([m], new Date(NOW - 2 * 3600_000));
  s.record([m], new Date(NOW - 30_000));
  s.record([{ ...m, yesPrice: 0.52 }], new Date(NOW)); // < 60s after the last one: skipped
  assert.equal(s.get("kalshi:A").length, 1, "old tick pruned, too-soon tick skipped");
  const file = path.join(await mkdtemp(path.join(tmpdir(), "prb-series-")), "h.json");
  await saveSeries(file, s);
  assert.deepEqual((await loadSeries(file)).get("kalshi:A"), [{ t: NOW - 30_000, p: 0.5, v: 100 }]);
});

test("paper: follows an unusual breakout and sells near the high", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-unusual-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: follow
    name: Follow unusual moves
    action: paper
    entry:
      unusual_move: { window_minutes: 60, min_move: 0.05, min_zscore: 3, min_volume_ratio: 3 }
      side: with_move
    exit: { trailing_stop: 0.04, trailing_activation: 0.03 }
    risk: { position_size_fraction: 0.05, max_position_usd: 50, bankroll_usd: 1000 }
`,
  );
  const ledgerPath = path.join(dir, "ledger.json");
  const fixture = path.join(dir, "m.json");
  const T0 = NOW - 14 * 3600_000;
  // Quiet for 12h, a 1-hour breakout from 40¢ to 50¢ on heavy volume, a run to 58¢, then a pullback.
  const path_: Array<{ p: number; v: number }> = [];
  let v = 10_000;
  for (let i = 0; i < 144; i++) path_.push({ p: 0.4 + (i % 2 ? 0.004 : -0.004), v: (v += 30) });
  for (let i = 1; i <= 12; i++) path_.push({ p: 0.4 + (0.1 * i) / 12, v: (v += 700) });
  for (const p of [0.53, 0.55, 0.57, 0.58, 0.58, 0.56, 0.535]) path_.push({ p, v: (v += 300) });
  const events: EngineEvent[] = [];
  let bought = -1;
  let sold = -1;
  for (let i = 0; i < path_.length; i++) {
    const now = new Date(T0 + i * 5 * 60_000);
    const { p, v: vol } = path_[i];
    await writeFile(
      fixture,
      JSON.stringify([{ platform: "polymarket", id: "brk", title: "Breakout market", yesPrice: p, yesBid: p - 0.005, yesAsk: p + 0.005, volume24hUsd: vol, liquidityUsd: 50_000, closesInHours: 200 }]),
    );
    const res = await runPaperCycle({
      rulesPath: rules,
      ledgerPath,
      demo: true,
      now,
      emit: (e) => {
        events.push(e);
      },
      adapters: [new DemoAdapter("polymarket", { fixturePath: fixture, now: () => now })],
    });
    if (res.opened && bought < 0) bought = i;
    if (res.closed && sold < 0) sold = i;
  }
  assert.ok(bought >= 144 && bought < 156, `bought during the breakout (step ${bought})`);
  assert.ok(sold > bought, "sold later");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const pos = ledger.positions[0];
  assert.equal(pos.side, "yes");
  assert.equal(pos.exitReason, "trailing_stop");
  assert.ok((pos.realizedPnlUsd ?? 0) > 0, `made money: ${pos.realizedPnlUsd}`);
  assert.ok(events.some((e) => e.type === "entry_signal" && /unusual \+/.test(e.message)));
});
