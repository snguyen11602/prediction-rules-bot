/**
 * "Does it actually pay?" study, from Kalshi's public history: settled game-winner markets and
 * their hourly pre-game prices. Read-only. Three questions:
 *   1. Favorites: buy the favorite before the game, hold to the result.
 *   2. Long shots: buy the side under 30¢.
 *   3. Late movers: buy the side whose price rose in the last hours before the game.
 * Returns are per $1 put in, after the taker fee, buying at the ask.
 */

export interface StudyMarket {
  ticker: string;
  event: string;
  series: string;
  result: "yes" | "no";
  /** Game start, epoch ms. */
  start: number;
}

/** One hour of a market before its game: hours before the start, YES bid and ask at that hour's close. */
export interface PathPoint {
  h: number;
  bid: number;
  ask: number;
}

export interface Row {
  label: string;
  n: number;
  avgPrice: number;
  winRate: number;
  /** Win rate minus the price, in points: positive = wins more often than the price says. */
  edgePts: number;
  edgeSe: number;
  /** Average return per $1, after the fee, buying at the ask. */
  ret: number;
  retSe: number;
}

export const TAKER_FEE = 0.07;
export const MAX_SPREAD = 0.05;

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}
function se(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}

/** The quote `h` hours before the start, if the book was two-sided and tight enough to trust. */
export function quoteAt(path: PathPoint[], h: number): PathPoint | undefined {
  const p = path.find((x) => x.h === h);
  if (!p || !(p.bid > 0) || !(p.ask < 1) || p.ask < p.bid || p.ask - p.bid > MAX_SPREAD + 1e-9) return undefined;
  return p;
}

export interface Bet {
  ticker: string;
  series: string;
  start: number;
  /** Mid price when bought. */
  mid: number;
  ask: number;
  won: boolean;
  /** How far the mid moved over the lookback (late movers only). */
  move?: number;
}

export function betReturn(b: Pick<Bet, "ask" | "won">): number {
  return ((b.won ? 1 : 0) - b.ask - TAKER_FEE * b.ask * (1 - b.ask)) / b.ask;
}

export function summarize(label: string, bets: Bet[]): Row {
  if (!bets.length) return { label, n: 0, avgPrice: 0, winRate: 0, edgePts: 0, edgeSe: 0, ret: 0, retSe: 0 };
  const edges = bets.map((b) => (b.won ? 1 : 0) - b.mid);
  const rets = bets.map(betReturn);
  return {
    label,
    n: bets.length,
    avgPrice: mean(bets.map((b) => b.mid)),
    winRate: mean(bets.map((b) => (b.won ? 1 : 0))),
    edgePts: mean(edges) * 100,
    edgeSe: se(edges) * 100,
    ret: mean(rets),
    retSe: se(rets),
  };
}

type Paths = Map<string, PathPoint[]>;

function byGame(markets: StudyMarket[]): Map<string, StudyMarket[]> {
  const out = new Map<string, StudyMarket[]>();
  for (const m of markets) out.set(m.event, [...(out.get(m.event) ?? []), m]);
  return out;
}

/** One bet per game: the favorite `h` hours before the start, if its mid is in [lo, hi). */
export function favoriteBets(markets: StudyMarket[], paths: Paths, h: number, lo: number, hi: number): Bet[] {
  const out: Bet[] = [];
  for (const sides of byGame(markets).values()) {
    let best: Bet | undefined;
    for (const m of sides) {
      const q = quoteAt(paths.get(m.ticker) ?? [], h);
      if (!q) continue;
      const mid = (q.bid + q.ask) / 2;
      if (!best || mid > best.mid) best = { ticker: m.ticker, series: m.series, start: m.start, mid, ask: q.ask, won: m.result === "yes" };
    }
    if (best && best.mid >= lo && best.mid < hi) out.push(best);
  }
  return out;
}

/** Every side priced under `below`, `h` hours before the start. */
export function longShotBets(markets: StudyMarket[], paths: Paths, h: number, below: number): Bet[] {
  const out: Bet[] = [];
  for (const m of markets) {
    const q = quoteAt(paths.get(m.ticker) ?? [], h);
    if (!q) continue;
    const mid = (q.bid + q.ask) / 2;
    if (mid < below) out.push({ ticker: m.ticker, series: m.series, start: m.start, mid, ask: q.ask, won: m.result === "yes" });
  }
  return out;
}

/**
 * One bet per game: the side whose mid rose the most between `from` and `to` hours before the
 * start (at least `minMove`), bought at the ask `to` hours before, priced 30–95¢.
 */
export function lateMoverBets(markets: StudyMarket[], paths: Paths, from: number, to: number, minMove: number, lo = 0.3, hi = 0.95): Bet[] {
  const out: Bet[] = [];
  for (const sides of byGame(markets).values()) {
    let best: Bet | undefined;
    for (const m of sides) {
      const path = paths.get(m.ticker) ?? [];
      const a = quoteAt(path, from);
      const b = quoteAt(path, to);
      if (!a || !b) continue;
      const mid = (b.bid + b.ask) / 2;
      const move = mid - (a.bid + a.ask) / 2;
      if (move < minMove - 1e-9 || mid < lo || mid > hi) continue;
      if (!best || move > best.move!) best = { ticker: m.ticker, series: m.series, start: m.start, mid, ask: b.ask, won: m.result === "yes", move };
    }
    if (best) out.push(best);
  }
  return out.sort((x, y) => x.start - y.start);
}

export interface StudyReport {
  games: number;
  markets: number;
  from?: string;
  to?: string;
  favorites: Row[];
  longShots: Row[];
  lateMovers: Row[];
}

export function runStudy(markets: StudyMarket[], paths: Paths): StudyReport {
  const starts = markets.map((m) => m.start).sort((a, b) => a - b);
  const fav = (label: string, lo: number, hi: number) => summarize(label, favoriteBets(markets, paths, 1, lo, hi));
  const movers = lateMoverBets(markets, paths, 12, 1, 0.02);
  const half = Math.floor(movers.length / 2);
  return {
    games: byGame(markets).size,
    markets: markets.length,
    from: starts.length ? new Date(starts[0]).toISOString().slice(0, 10) : undefined,
    to: starts.length ? new Date(starts[starts.length - 1]).toISOString().slice(0, 10) : undefined,
    favorites: [fav("favorites 50–70¢", 0.5, 0.7), fav("favorites 70–85¢", 0.7, 0.85), fav("favorites 85–95¢", 0.85, 0.95), fav("all favorites 50–95¢", 0.5, 0.95)],
    longShots: [summarize("under 10¢", longShotBets(markets, paths, 1, 0.1)), summarize("under 30¢", longShotBets(markets, paths, 1, 0.3))],
    lateMovers: [
      summarize("rose 2¢+ (12h → 1h before)", movers),
      summarize("  first half of the games", movers.slice(0, half)),
      summarize("  second half", movers.slice(half)),
      summarize("rose 2¢+ (12h → 3h before)", lateMoverBets(markets, paths, 12, 3, 0.02)),
      summarize("rose 2¢+ (24h → 1h before)", lateMoverBets(markets, paths, 24, 1, 0.02)),
    ],
  };
}

/** "likely real" needs both the win-rate gap and the after-fee return to clear two standard errors. */
export function verdict(r: Row): string {
  if (r.n < 100) return "too few games to say";
  const tRet = r.retSe ? r.ret / r.retSe : 0;
  if (tRet >= 2) return "made money, and unlikely to be luck";
  if (tRet <= -2) return "lost money, and unlikely to be luck";
  if (r.ret > 0) return "ahead, but within luck";
  return "behind, but within luck";
}

export function formatRows(rows: Row[]): string {
  const pct = (x: number) => `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)}%`;
  return rows
    .map((r) =>
      r.n
        ? `  ${r.label.padEnd(30)} ${String(r.n).padStart(5)} bets  avg price ${(r.avgPrice * 100).toFixed(0).padStart(2)}¢  won ${(r.winRate * 100).toFixed(0).padStart(2)}%  (${r.edgePts >= 0 ? "+" : "−"}${Math.abs(r.edgePts).toFixed(1)} pts vs price, ±${r.edgeSe.toFixed(1)})  return per $1: ${pct(r.ret)} ±${(r.retSe * 100).toFixed(1)}  → ${verdict(r)}`
        : `  ${r.label.padEnd(30)}     0 bets`,
    )
    .join("\n");
}
