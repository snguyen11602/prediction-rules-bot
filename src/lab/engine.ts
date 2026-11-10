import { stringify } from "yaml";
import type { LabData, LabMarket } from "./data.js";
import { LEAGUE_LABEL } from "./data.js";
import { kalshiLeague } from "../platforms/kalshi.js";
import { LEAGUE_NAMES, type LeagueId } from "../types.js";

/**
 * The backtest lab's engine: pick bets from settled games by rule, size them, and measure the
 * result; then a Monte Carlo simulation of what a run of such bets could do next. Pure functions.
 * Prices are 0–1; money is dollars; returns are per $1 staked, after fees.
 */

export type PickRule = "favorite" | "underdog" | "riser" | "faller" | "all";

export interface LabParams {
  /** Which side of a game to buy. */
  pick: PickRule;
  /** The side's mid price when bought must be in [minPrice, maxPrice]. */
  minPrice: number;
  maxPrice: number;
  /** Buy this many hours before the start. */
  entryH: number;
  /** Risers / fallers: compare with the price this many hours before the start… */
  fromH: number;
  /** …and require at least this much of a move. */
  minMove: number;
  /** Ignore quotes from a book wider than this. */
  maxSpread: number;
  /** Leagues (series) to include; empty = all. */
  leagues: string[];
  /** Game start window, epoch ms. */
  from?: number;
  to?: number;
  /** taker = buy at the ask now. maker = a resting order at the bid, assumed to always fill (optimistic). */
  exec: "taker" | "maker";
  /** result = hold until the game is decided. pregame = sell at the bid `exitH` hours before the start. */
  exit: "result" | "pregame";
  exitH: number;
  /** flat = `size` dollars a bet. percent = `pct` of the bankroll at the time. */
  stake: "flat" | "percent";
  size: number;
  pct: number;
  bankroll: number;
}

export const DEFAULT_PARAMS: LabParams = {
  pick: "favorite",
  minPrice: 0.85,
  maxPrice: 0.95,
  entryH: 1,
  fromH: 12,
  minMove: 0.02,
  maxSpread: 0.05,
  leagues: [],
  exec: "taker",
  exit: "result",
  exitH: 0,
  stake: "flat",
  size: 25,
  pct: 0.02,
  bankroll: 1000,
};

export const TAKER_FEE = 0.07;
export const MAKER_FEE = 0.0175;

export interface LabBet {
  ticker: string;
  series: string;
  /** Who was bought, and in which game. */
  side: string;
  game: string;
  start: number;
  /** Price paid per contract and the mid at that moment. */
  price: number;
  mid: number;
  won: boolean;
  /** What a contract was worth at the exit (1 / 0, or the bid when sold before the game). */
  exitValue: number;
  /** Profit per $1 staked, after fees. */
  ret: number;
  /** Price move over the lookback (risers / fallers). */
  move?: number;
  /** Meant to be sold before the game, but there was no usable price then, so it was held to the result. */
  rode?: boolean;
}

interface Quote {
  bid: number;
  ask: number;
  mid: number;
}

function quote(m: LabMarket, h: number, maxSpread: number): Quote | undefined {
  for (let i = 0; i < m.p.length; i += 3) {
    if (m.p[i] !== h) continue;
    const bid = m.p[i + 1] / 1000;
    const ask = m.p[i + 2] / 1000;
    if (ask - bid > maxSpread + 1e-9) return undefined;
    return { bid, ask, mid: (bid + ask) / 2 };
  }
  return undefined;
}

/** "Boston vs New York" from the sides of a game (the draw isn't a team). */
function gameName(sides: LabMarket[]): string {
  const teams = sides.map((m) => m.n).filter((n) => n && !/^(tie|draw)$/i.test(n));
  return teams.length >= 2 ? teams.slice(0, 2).join(" vs ") : (sides[0]?.q ?? "");
}

function toBet(m: LabMarket, q: Quote, p: LabParams, game: string, move?: number): LabBet {
  const price = p.exec === "maker" ? q.bid : q.ask;
  const feeIn = (p.exec === "maker" ? MAKER_FEE : TAKER_FEE) * price * (1 - price);
  let exitValue: number = m.r;
  let feeOut = 0;
  let rode: boolean | undefined;
  if (p.exit === "pregame" && p.exitH < p.entryH) {
    // Sell to the bid before the game; with no trustworthy quote then, the bet rides to the result.
    const out = quote(m, p.exitH, p.maxSpread);
    if (out) {
      exitValue = out.bid;
      feeOut = TAKER_FEE * out.bid * (1 - out.bid);
    } else rode = true;
  }
  return { ticker: m.t, series: m.s, side: m.n, game, start: m.st, price, mid: q.mid, won: m.r === 1, exitValue, ret: (exitValue - feeOut - price - feeIn) / price, move, rode };
}

/** The bets a rule would have made, oldest first. One per game, except "all" (every side in the price range). */
export function pickBets(data: LabData, p: LabParams): LabBet[] {
  const leagues = new Set(p.leagues);
  const games = new Map<string, LabMarket[]>();
  for (const m of data.markets) {
    if (leagues.size && !leagues.has(m.s)) continue;
    if ((p.from != null && m.st < p.from) || (p.to != null && m.st > p.to)) continue;
    const g = games.get(m.e);
    if (g) g.push(m);
    else games.set(m.e, [m]);
  }
  const inBand = (q: Quote) => q.mid >= p.minPrice - 1e-9 && q.mid <= p.maxPrice + 1e-9 && q.ask < 1 && q.bid > 0;
  const out: LabBet[] = [];
  for (const sides of games.values()) {
    const quoted = sides.map((m) => ({ m, q: quote(m, p.entryH, p.maxSpread) })).filter((x): x is { m: LabMarket; q: Quote } => !!x.q);
    if (!quoted.length) continue;
    const game = gameName(sides);
    if (p.pick === "all") {
      for (const { m, q } of quoted) if (inBand(q)) out.push(toBet(m, q, p, game));
      continue;
    }
    let best: { m: LabMarket; q: Quote; score: number; move?: number } | undefined;
    for (const { m, q } of quoted) {
      let score: number;
      let move: number | undefined;
      if (p.pick === "favorite") score = q.mid;
      else if (p.pick === "underdog") score = -q.mid;
      else {
        const then = quote(m, p.fromH, p.maxSpread);
        if (!then || p.fromH <= p.entryH) continue;
        move = q.mid - then.mid;
        if (p.pick === "riser" ? move < p.minMove - 1e-9 : move > -p.minMove + 1e-9) continue;
        if (!inBand(q)) continue; // the biggest mover that is also in the price range
        score = p.pick === "riser" ? move : -move;
      }
      if (!best || score > best.score) best = { m, q, score, move };
    }
    if (!best || !inBand(best.q)) continue; // the game's favorite (or underdog) must itself be in the range
    if (p.pick === "favorite" || p.pick === "underdog") {
      // "The favorite" needs every side's price. When a side has no usable quote, the mids don't
      // add up to about $1 and the comparison is a guess (a favorite at 50¢ or more is still certain).
      const whole = quoted.reduce((a, x) => a + x.q.mid, 0) >= 0.9;
      if (!whole && !(p.pick === "favorite" && best.q.mid >= 0.5)) continue;
    }
    out.push(toBet(best.m, best.q, p, game, best.move));
  }
  return out.sort((a, b) => a.start - b.start || a.ticker.localeCompare(b.ticker));
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
function stderr(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1) / xs.length);
}

export interface Slice {
  key: string;
  label: string;
  bets: number;
  wins: number;
  avgPrice: number;
  winRate: number;
  /** Win rate minus average price, in points. */
  edgePts: number;
  ret: number;
  retSe: number;
  pnl: number;
}

function slice(key: string, label: string, bets: LabBet[], pnl: number): Slice {
  const rets = bets.map((b) => b.ret);
  const wins = bets.filter((b) => b.won).length;
  const avgPrice = mean(bets.map((b) => b.price));
  return { key, label, bets: bets.length, wins, avgPrice, winRate: bets.length ? wins / bets.length : 0, edgePts: bets.length ? (wins / bets.length - avgPrice) * 100 : 0, ret: mean(rets), retSe: stderr(rets), pnl };
}

export interface LabTrade extends LabBet {
  stake: number;
  pnl: number;
  /** Bankroll after this bet. */
  bankroll: number;
}

export interface LabStats {
  bets: number;
  wins: number;
  winRate: number;
  avgPrice: number;
  edgePts: number;
  edgeSe: number;
  /** Average profit per $1 staked, with its standard error and t value. */
  ret: number;
  retSe: number;
  t: number;
  staked: number;
  pnl: number;
  endBankroll: number;
  /** Largest fall from a peak, in dollars and as a share of that peak's bankroll. */
  maxDrawdown: number;
  maxDrawdownPct: number;
  longestLosing: number;
  /** Total won ÷ total lost (above 1 = profitable). */
  profitFactor: number;
  days: number;
  betsPerDay: number;
  bestDay: number;
  worstDay: number;
  /** Lowest point of the bankroll, relative to where it started (0 if it never dipped below). */
  lowest: number;
  /** When the bankroll first ran out, if it did (flat bets keep going as if it were topped up). */
  bustAt?: number;
}

export interface LabResult {
  stats: LabStats;
  verdict: string;
  trades: LabTrade[];
  byLeague: Slice[];
  byMonth: Slice[];
  byPrice: Slice[];
}

/** Same bar as `npm run study`: at least 100 bets and two standard errors before anything is called real. */
export function verdictOf(bets: number, ret: number, retSe: number): string {
  if (bets === 0) return "no bets matched";
  if (bets < 100) return "too few bets to say";
  const t = retSe ? ret / retSe : 0;
  if (t >= 2) return "made money, and unlikely to be luck";
  if (t <= -2) return "lost money, and unlikely to be luck";
  return ret > 0 ? "ahead, but within luck" : "behind, but within luck";
}

/**
 * Run the bets through the staking plan in time order (each bet settles before the next is sized).
 * The test measures the strategy on every bet: flat bets keep their size even after the bankroll
 * would have run out (that moment is reported), so one unlucky stretch doesn't hide the rest.
 * Whether a bankroll survives is the Monte Carlo simulation's question.
 */
export function backtest(bets: LabBet[], p: Pick<LabParams, "stake" | "size" | "pct" | "bankroll">): LabResult {
  let bankroll = p.bankroll;
  let peak = bankroll;
  let maxDd = 0;
  let maxDdPct = 0;
  let streak = 0;
  let longest = 0;
  let lowest = 0;
  let bustAt: number | undefined;
  const trades: LabTrade[] = [];
  for (const b of bets) {
    const stake = p.stake === "flat" ? p.size : Math.max(0, bankroll) * p.pct;
    const pnl = stake * b.ret;
    bankroll += pnl;
    peak = Math.max(peak, bankroll);
    lowest = Math.min(lowest, bankroll - p.bankroll);
    if (bankroll <= 0 && bustAt == null) bustAt = b.start;
    if (peak - bankroll > maxDd) maxDd = peak - bankroll;
    if (peak > 0) maxDdPct = Math.max(maxDdPct, Math.min(1, (peak - bankroll) / peak));
    streak = pnl < 0 ? streak + 1 : 0;
    longest = Math.max(longest, streak);
    trades.push({ ...b, stake, pnl, bankroll });
  }
  const done: LabBet[] = trades;
  const rets = done.map((b) => b.ret);
  const edges = done.map((b) => (b.won ? 1 : 0) - b.price);
  const wins = done.filter((b) => b.won).length;
  const gains = trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
  const losses = -trades.filter((t) => t.pnl < 0).reduce((a, t) => a + t.pnl, 0);
  const byDay = new Map<string, number>();
  for (const t of trades) {
    const d = new Date(t.start).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) ?? 0) + t.pnl);
  }
  const dayPnls = [...byDay.values()];
  const ret = mean(rets);
  const retSe = stderr(rets);
  const stats: LabStats = {
    bets: trades.length,
    wins,
    winRate: trades.length ? wins / trades.length : 0,
    avgPrice: mean(done.map((b) => b.price)),
    edgePts: mean(edges) * 100,
    edgeSe: stderr(edges) * 100,
    ret,
    retSe,
    t: retSe ? ret / retSe : 0,
    staked: trades.reduce((a, t) => a + t.stake, 0),
    pnl: bankroll - p.bankroll,
    endBankroll: bankroll,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    longestLosing: longest,
    profitFactor: losses > 0 ? gains / losses : gains > 0 ? Infinity : 0,
    days: byDay.size,
    betsPerDay: byDay.size ? trades.length / byDay.size : 0,
    bestDay: dayPnls.length ? Math.max(...dayPnls) : 0,
    worstDay: dayPnls.length ? Math.min(...dayPnls) : 0,
    lowest,
    bustAt,
  };
  const group = (keyOf: (t: LabTrade) => string, labelOf: (k: string) => string, order?: (a: Slice, b: Slice) => number): Slice[] => {
    const m = new Map<string, LabTrade[]>();
    for (const t of trades) m.set(keyOf(t), [...(m.get(keyOf(t)) ?? []), t]);
    const rows = [...m].map(([k, ts]) => slice(k, labelOf(k), ts, ts.reduce((a, t) => a + t.pnl, 0)));
    return rows.sort(order ?? ((a, b) => a.key.localeCompare(b.key)));
  };
  const month = (k: string) => new Date(`${k}-15T00:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  return {
    stats,
    verdict: verdictOf(stats.bets, ret, retSe),
    trades,
    byLeague: group((t) => t.series, (k) => LEAGUE_LABEL[k] ?? k, (a, b) => b.bets - a.bets),
    byMonth: group((t) => new Date(t.start).toISOString().slice(0, 7), month),
    byPrice: group((t) => String(Math.min(9, Math.floor(t.price * 10 + 1e-9))), (k) => `${Number(k) * 10}–${Number(k) * 10 + 10}¢`, (a, b) => Number(a.key) - Number(b.key)),
  };
}

// ---- Monte Carlo ---------------------------------------------------------------------------

export interface McOptions {
  /** How many simulated futures. */
  runs: number;
  /** How many bets in each. */
  horizon: number;
  stake: "flat" | "percent";
  size: number;
  pct: number;
  bankroll: number;
  /** "Ruin" = the bankroll falls to this share of where it started (0.5 = lose half). */
  ruinAt: number;
  seed: number;
}

export interface McResult {
  runs: number;
  horizon: number;
  /** Final profit / loss across the runs. */
  final: { p5: number; p25: number; p50: number; p75: number; p95: number; mean: number; min: number; max: number };
  profitChance: number;
  ruinChance: number;
  /** Largest peak-to-trough fall within a run, as a share of the peak. */
  drawdown: { p50: number; p95: number };
  /** Profit / loss through time: percentiles across the runs at evenly spaced bet counts. */
  bands: { x: number[]; p5: number[]; p25: number[]; p50: number[]; p75: number[]; p95: number[] };
  /** Distribution of the final profit / loss. */
  hist: { lo: number; hi: number; counts: number[] };
  /** A few individual runs, at the same bet counts as `bands`. */
  samples: number[][];
}

/** Small seeded generator, so the same settings draw the same simulation. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pct(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = (sorted.length - 1) * q;
  const lo = Math.floor(i);
  const hi = Math.ceil(i);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
}

/**
 * Bootstrap: each simulated future draws `horizon` bets at random (with replacement) from the
 * backtest's own results and runs them through the same staking. It answers "if the next bets look
 * like these ones, how wide is the range of outcomes?" It can't know if the future will look like
 * the past, and it treats bets as independent of each other.
 */
export function monteCarlo(rets: number[], o: McOptions): McResult | null {
  if (!rets.length || o.horizon < 1 || o.runs < 1) return null;
  const rand = mulberry32(o.seed);
  const points = Math.min(60, o.horizon);
  const marks = Array.from({ length: points }, (_, i) => Math.round(((i + 1) * o.horizon) / points));
  const at: Float64Array[] = marks.map(() => new Float64Array(o.runs));
  const finals = new Float64Array(o.runs);
  const dds = new Float64Array(o.runs);
  const samples: number[][] = [];
  let profit = 0;
  let ruin = 0;
  const ruinLevel = o.bankroll * o.ruinAt;
  for (let r = 0; r < o.runs; r++) {
    let bank = o.bankroll;
    let peak = bank;
    let dd = 0;
    let ruined = false;
    let k = 0;
    const path: number[] = [];
    for (let i = 1; i <= o.horizon; i++) {
      if (bank > 0.005) {
        const stake = Math.min(bank, o.stake === "flat" ? o.size : bank * o.pct);
        bank += stake * rets[Math.floor(rand() * rets.length)];
        if (bank > peak) peak = bank;
        else if (peak > 0 && (peak - bank) / peak > dd) dd = (peak - bank) / peak;
        if (bank <= ruinLevel) ruined = true;
      } else rand(); // keep the draw count the same for every run
      if (i === marks[k]) {
        at[k][r] = bank - o.bankroll;
        if (r < 12) path.push(bank - o.bankroll);
        k++;
      }
    }
    finals[r] = bank - o.bankroll;
    dds[r] = dd;
    if (bank > o.bankroll) profit++;
    if (ruined) ruin++;
    if (r < 12) samples.push(path);
  }
  const sortedFinal = Array.from(finals).sort((a, b) => a - b);
  const sortedDd = Array.from(dds).sort((a, b) => a - b);
  const band = (q: number) => at.map((col) => pct(Array.from(col).sort((a, b) => a - b), q));
  // Histogram over the middle 99% so one freak run doesn't flatten the picture.
  const lo = pct(sortedFinal, 0.005);
  const hi = pct(sortedFinal, 0.995);
  const bins = 31;
  const counts = new Array<number>(bins).fill(0);
  if (hi > lo) for (const v of sortedFinal) counts[Math.max(0, Math.min(bins - 1, Math.floor(((v - lo) / (hi - lo)) * bins)))]++;
  else counts[Math.floor(bins / 2)] = sortedFinal.length;
  return {
    runs: o.runs,
    horizon: o.horizon,
    final: { p5: pct(sortedFinal, 0.05), p25: pct(sortedFinal, 0.25), p50: pct(sortedFinal, 0.5), p75: pct(sortedFinal, 0.75), p95: pct(sortedFinal, 0.95), mean: mean(sortedFinal), min: sortedFinal[0], max: sortedFinal[sortedFinal.length - 1] },
    profitChance: profit / o.runs,
    ruinChance: ruin / o.runs,
    drawdown: { p50: pct(sortedDd, 0.5), p95: pct(sortedDd, 0.95) },
    bands: { x: marks, p5: band(0.05), p25: band(0.25), p50: band(0.5), p75: band(0.75), p95: band(0.95) },
    hist: { lo, hi, counts },
    samples,
  };
}

/** A lab test written as a paper rule. Plain data: it parses with `RuleSchema`. */
export interface LabRuleData {
  id: string;
  name: string;
  enabled: true;
  action: "paper";
  filters: {
    platforms: ["kalshi"];
    market_types: ["game_winner"];
    leagues?: LeagueId[];
    min_price: number;
    max_price: number;
    max_spread: number;
    pre_game_only: true;
    min_hours_to_start?: number;
    max_hours_to_start: number;
  };
  entry: {
    side: "yes";
    yes_price_above?: number;
    pregame_move?: { min_move: number; lookback_hours: number; max_hours_to_start: number };
    max_buy_price: number;
  };
  risk: { bankroll_usd: number; position_size_fraction: number; max_position_usd: number; max_open_positions: number; fire_after_n_losses: 0 };
  paper: { slippage: number; include_fees: true };
}

export interface LabRule {
  rule: LabRuleData;
  /** Where the rule can't do exactly what the test did. */
  notes: string[];
}

/** Why the bot can't paper trade these settings, in plain words; null when it can. */
export function ruleBlocker(p: LabParams): string | null {
  if (p.exec === "maker") return "The bot's paper trades buy at the ask. It can't leave an order resting at the bid, so this test can't be paper traded.";
  if (p.exit === "pregame") return "The bot can't sell at a set time before the game, so this test can't be paper traded. Tests that hold to the result can.";
  if (p.pick === "underdog") return "A rule looks at one market at a time, so it can't tell which side is the underdog. \"Every side in a price range\" is the closest test the bot can run.";
  if (p.pick === "faller") return "The bot has no rule for buying the side whose price fell, so this test can't be paper traded.";
  if (p.pick === "favorite" && p.maxPrice < 0.5) return "A rule can only tell a favorite by a price of 50¢ or more, and this test's price range ends below that.";
  return null;
}

/** Extra cost per paper buy on top of the ask, as the bot's own paper rules use. */
const PAPER_SLIPPAGE = 0.005;

function shortHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36).padStart(7, "0").slice(-6);
}

/**
 * The paper rule that does what these settings test: favorites, risers or every side in a price
 * range, bought at the ask and held to the result. The id depends only on which bets are picked
 * (not on the money), so adding the same test again with another bet size updates one strategy
 * instead of making two that buy the same games.
 */
export function ruleFor(p: LabParams): LabRule | null {
  if (ruleBlocker(p)) return null;
  const r3 = (x: number) => Math.round(x * 1000) / 1000;
  const notes: string[] = [];
  // A rule sees one market at a time, so it can only tell a favorite by its price: 50¢ or more.
  const min = p.pick === "favorite" ? Math.max(0.5, p.minPrice) : p.minPrice;
  if (min > p.minPrice + 1e-9) notes.push(`The test started at ${Math.round(p.minPrice * 100)}¢. A rule can only tell a favorite by its price, so this one starts at 50¢.`);
  const leagues = [...new Set(p.leagues.map((s) => kalshiLeague(s)).filter((l): l is LeagueId => l != null))].sort();
  // The test used the price about `entryH` hours before the start: the same hour-wide window.
  const lo = Math.max(0, p.entryH - 0.5);
  const hi = p.entryH + 0.5;
  const riser = p.pick === "riser";
  const lookback = Math.max(2, p.fromH - p.entryH);
  if (riser && lookback !== p.fromH - p.entryH) notes.push("The bot compares prices at least 2 hours apart, a little more than this test did.");
  const stake = p.stake === "flat" ? Math.min(p.size, p.bankroll) : p.bankroll * p.pct;
  if (p.stake === "percent") notes.push(`The bot bets ${Math.round(p.pct * 1000) / 10}% of the starting bankroll every time; the test let that grow and shrink with results.`);
  notes.push("Paper fills add half a cent of slippage to every buy, which the test doesn't.");
  const range = `${Math.round(min * 100)}–${Math.round(p.maxPrice * 100)}¢`;
  const what = p.pick === "favorite" ? "favorites" : riser ? "late movers" : "every side";
  const names = leagues.map((l) => LEAGUE_NAMES[l]);
  const key = [p.pick, r3(min), r3(p.maxPrice), p.entryH, riser ? lookback : "", riser ? r3(p.minMove) : "", r3(p.maxSpread), leagues.join("+")].join("|");
  const rule: LabRuleData = {
    id: `lab-${p.pick}-${Math.round(min * 100)}-${Math.round(p.maxPrice * 100)}-${shortHash(key)}`,
    name: `Lab ${what} ${range}${names.length ? `, ${names.length > 3 ? `${names.length} leagues` : names.join(" + ")}` : ""}`,
    enabled: true,
    action: "paper",
    filters: {
      platforms: ["kalshi"],
      market_types: ["game_winner"],
      ...(leagues.length ? { leagues } : {}),
      min_price: r3(min),
      max_price: r3(p.maxPrice),
      max_spread: r3(p.maxSpread),
      pre_game_only: true,
      ...(lo > 0 ? { min_hours_to_start: lo } : {}),
      max_hours_to_start: hi,
    },
    entry: {
      side: "yes",
      ...(riser ? { pregame_move: { min_move: r3(p.minMove), lookback_hours: lookback, max_hours_to_start: Math.min(24, hi) } } : { yes_price_above: r3(min) }),
      // The range is on the mid price, like the test; the buy itself may cost half the spread more,
      // plus slippage. A rule's limit has to stay under $1.
      max_buy_price: Math.max(0.01, Math.min(0.99, r3(p.maxPrice + p.maxSpread / 2 + PAPER_SLIPPAGE))),
    },
    risk: {
      bankroll_usd: Math.round(p.bankroll),
      position_size_fraction: Math.min(1, Math.round((stake / p.bankroll) * 10000) / 10000),
      max_position_usd: Math.max(1, Math.round(stake * 100) / 100),
      // The test bets on every game that fits; the bankroll check is what limits how many are open.
      max_open_positions: Math.max(5, Math.min(200, Math.floor(p.bankroll / Math.max(1, stake)))),
      fire_after_n_losses: 0,
    },
    paper: { slippage: PAPER_SLIPPAGE, include_fees: true },
  };
  return { rule, notes };
}

/** The same rule as text to paste under `rules:` in a rules file (the notes become comments). */
export function ruleYaml(p: LabParams): string | null {
  const made = ruleFor(p);
  if (!made) return null;
  const body = stringify([made.rule], { lineWidth: 0 }).trimEnd().split("\n");
  return [...made.notes.map((n) => `# ${n}`), ...body].map((l) => `  ${l}`).join("\n");
}
