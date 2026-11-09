import { test } from "node:test";
import assert from "node:assert/strict";
import { betReturn, favoriteBets, formatRows, lateMoverBets, longShotBets, quoteAt, runStudy, summarize, verdict, type PathPoint, type StudyMarket } from "./study.js";

const mk = (event: string, side: string, result: "yes" | "no", start = 1_000_000): StudyMarket => ({ ticker: `${event}-${side}`, event, series: "KXNBAGAME", result, start });
const path = (...pts: Array<[number, number, number]>): PathPoint[] => pts.map(([h, bid, ask]) => ({ h, bid, ask }));

test("study: a bet's return is after the ask and the taker fee", () => {
  // Buy at 80¢: fee 0.07 × 0.8 × 0.2 = 1.12¢. Win → (100 − 80 − 1.12) / 80.
  assert.equal(+betReturn({ ask: 0.8, won: true }).toFixed(4), 0.236);
  assert.equal(+betReturn({ ask: 0.8, won: false }).toFixed(4), -1.014);
});

test("study: quotes from an empty or wide book are ignored", () => {
  assert.equal(quoteAt(path([1, 0, 1]), 1), undefined);
  assert.equal(quoteAt(path([1, 0.5, 0.6]), 1), undefined);
  assert.deepEqual(quoteAt(path([1, 0.5, 0.52]), 1), { h: 1, bid: 0.5, ask: 0.52 });
  assert.equal(quoteAt(path([2, 0.5, 0.52]), 1), undefined);
});

test("study: one favorite and one late mover per game; long shots counted per side", () => {
  const markets = [mk("G1", "A", "yes"), mk("G1", "B", "no"), mk("G2", "A", "no"), mk("G2", "B", "yes")];
  const paths = new Map<string, PathPoint[]>([
    ["G1-A", path([12, 0.7, 0.72], [1, 0.75, 0.77])], // favorite, rose 5¢, won
    ["G1-B", path([12, 0.28, 0.3], [1, 0.23, 0.25])],
    ["G2-A", path([12, 0.6, 0.62], [1, 0.6, 0.62])], // favorite, flat, lost
    ["G2-B", path([12, 0.38, 0.4], [1, 0.38, 0.4])],
  ]);
  const favs = favoriteBets(markets, paths, 1, 0.5, 0.95);
  assert.deepEqual(favs.map((b) => [b.ticker, b.won]), [["G1-A", true], ["G2-A", false]]);
  const movers = lateMoverBets(markets, paths, 12, 1, 0.02);
  assert.deepEqual(movers.map((b) => b.ticker), ["G1-A"]);
  assert.equal(+movers[0].move!.toFixed(2), 0.05);
  assert.deepEqual(longShotBets(markets, paths, 1, 0.3).map((b) => b.ticker), ["G1-B"]);
  const row = summarize("favorites", favs);
  assert.equal(row.n, 2);
  assert.equal(row.winRate, 0.5);
  const rep = runStudy(markets, paths);
  assert.equal(rep.games, 2);
  assert.match(formatRows(rep.lateMovers), /rose 2¢\+ \(12h → 1h before\)\s+1 bets/);
});

test("study: a result is only called real with enough bets and two standard errors", () => {
  const base = { label: "x", avgPrice: 0.6, winRate: 0.6, edgePts: 0, edgeSe: 1 };
  assert.equal(verdict({ ...base, n: 50, ret: 0.2, retSe: 0.01 }), "too few games to say");
  assert.equal(verdict({ ...base, n: 500, ret: 0.03, retSe: 0.03 }), "ahead, but within luck");
  assert.equal(verdict({ ...base, n: 500, ret: -0.03, retSe: 0.03 }), "behind, but within luck");
  assert.equal(verdict({ ...base, n: 500, ret: 0.08, retSe: 0.03 }), "made money, and unlikely to be luck");
  assert.equal(verdict({ ...base, n: 500, ret: -0.2, retSe: 0.05 }), "lost money, and unlikely to be luck");
});
