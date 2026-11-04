import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CopyTradingConfig } from "../rules/schema.js";
import type { PolymarketDataClient, TraderTrade } from "../platforms/polymarket-data.js";
import type { KalshiPeriod, KalshiSocialClient, KalshiSocialTrade } from "../platforms/kalshi-social.js";
import { hasStarted } from "./evaluate.js";
import { platformName, type NormalizedMarket, type PlatformId, type SignalSide } from "../types.js";
import { findMatches } from "./match.js";
import { buyPrice } from "./pricing.js";
import { cents, usd, type Check } from "./trace.js";

/**
 * Copy trading, the pure-ish parts: pick leaders from global Polymarket's and Kalshi's public
 * leaderboards, read their new fills, and find the same bet on an exchange you can trade
 * (Polymarket US / Kalshi). Nothing here places orders; the paper session decides and records
 * hypothetical fills.
 */

export interface Leader {
  /** 0x… proxy wallet on global Polymarket, `kalshi:<nickname>` on Kalshi. */
  wallet: string;
  name: string;
  /** Where they trade (missing = global Polymarket, from before Kalshi leaders existed). */
  source?: "polymarket" | "kalshi";
  /** Leaderboard PnL over the configured window, USD. */
  windowPnlUsd: number;
  /** Distinct markets traded, lifetime. */
  markets: number;
  /** Closed positions with a result in the sample, and how many made money (Polymarket only). */
  decided: number;
  wins: number;
  winRate: number;
  /** Kalshi: profit over their whole account, USD. */
  lifetimePnlUsd?: number;
  /** Kalshi: how their recent parlays went (from the trades they show). */
  parlays?: { won: number; lost: number; open: number };
}

export const KALSHI_PREFIX = "kalshi:";
export const isKalshiWallet = (w: string) => w.toLowerCase().startsWith(KALSHI_PREFIX);
const kalshiNick = (w: string) => w.slice(KALSHI_PREFIX.length);
/** Kalshi parlays ("combos") are multivariate markets with these tickers. */
export const isKalshiCombo = (ticker: string) => /^KXMVE/i.test(ticker);

export interface CopyDecision {
  at: string;
  wallet: string;
  leader: string;
  title: string;
  outcome: string;
  /** The leader's average price for this bet. */
  price: number;
  usd: number;
  result: "copied" | "alerted" | "skipped";
  reason?: string;
  target?: { platform: PlatformId; id: string; title: string; side: SignalSide; price?: number };
}

export interface CopyState {
  version: 1;
  leaders?: { at: string; list: Leader[]; considered: number };
  /** After a failed leaderboard read, don't try again before this (ISO). */
  leadersRetryAt?: string;
  /** Newest fill timestamp seen per wallet (epoch seconds). */
  lastSeen: Record<string, number>;
  /** Fills already processed (polls overlap a little, so late-indexed fills aren't skipped). */
  seen: string[];
  /**
   * The leader sold this bet: `${wallet}|${market}|${outcome}` → epoch seconds of their latest sell.
   * Kept until it's old, so a copy still sells on a later check if it couldn't sell right away.
   */
  exits: Record<string, number>;
  lastPollAt?: string;
  recent: CopyDecision[];
  /** Kalshi leaders, refreshed on the same schedule as the Polymarket ones. */
  kalshiLeaders?: { at: string; list: Leader[]; considered: number; hidden: number };
  kalshiRetryAt?: string;
  /** Kalshi traders who keep their trades private (lowercase nickname → epoch seconds checked). */
  kalshiPrivate?: Record<string, number>;
  /** Settled Kalshi parlays: ticker → result (results never change, so they're read once). */
  comboResults?: Record<string, { r: "won" | "lost"; at: number }>;
  /** Parlays: legs the leaders put big money on, waiting to be combined. */
  legs?: LegCandidate[];
  /** Leader parlays already handled (`${wallet}|${ticker}`), so each is copied or reported once. */
  parlaySeen?: Record<string, number>;
  /** Leader parlays that couldn't be read yet (Kalshi busy): tried again while fresh. */
  parlayPending?: LeaderBet[];
  parlayRecent?: ParlayDecision[];
}

/** One outcome the leaders bought, on an exchange you can trade, as a possible parlay leg. */
export interface LegCandidate {
  /** `${platform}:${marketId}:${side}` */
  key: string;
  platform: PlatformId;
  marketId: string;
  side: SignalSide;
  title: string;
  url?: string;
  /** Legs of one game never go in the same parlay. */
  game: string;
  /** Leaders' USD on this outcome, summed over their bets. */
  backingUsd: number;
  leaders: string[];
  /** Size-weighted price the leaders paid for this side. */
  leaderPrice: number;
  firstAt: string;
  lastAt: string;
  /** Put in a parlay (or suggested) already: never reused. */
  usedAt?: string;
}

export interface ParlayDecision {
  at: string;
  kind: "built" | "leader";
  result: "opened" | "alerted" | "skipped";
  title: string;
  legs: number;
  leader?: string;
  /** Combined price (per $1 payout). */
  price?: number;
  /** Leader's stake on their parlay. */
  usd?: number;
  reason?: string;
}

/** Same key for a leader's bet and our copy of it. */
export function betKey(wallet: string, market: string | undefined, outcome: string): string {
  return `${wallet.toLowerCase()}|${market ?? ""}|${outcome}`;
}

export function copyStatePathFor(ledgerPath: string): string {
  return ledgerPath.replace(/\.json$/i, "") + ".copy.json";
}

export async function loadCopyState(file: string): Promise<CopyState> {
  try {
    const s = JSON.parse(await readFile(file, "utf8")) as CopyState;
    if (s?.version === 1) {
      return {
        ...s,
        lastSeen: s.lastSeen ?? {},
        seen: Array.isArray(s.seen) ? s.seen : [],
        exits: s.exits ?? {},
        recent: Array.isArray(s.recent) ? s.recent : [],
      };
    }
  } catch {
    // missing or unreadable: start fresh (it's a cache)
  }
  return { version: 1, lastSeen: {}, seen: [], exits: {}, recent: [] };
}

export async function saveCopyState(file: string, s: CopyState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s));
  await rename(tmp, file);
}

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

/** Who to follow: profitable on the leaderboard, many markets, and a good recent win rate. */
export async function pickLeaders(client: PolymarketDataClient, cfg: CopyTradingConfig): Promise<{ list: Leader[]; considered: number; failed: number }> {
  const L = cfg.leaders;
  const exclude = new Set(L.exclude.map((w) => w.toLowerCase()));
  const rows = await client.leaderboard(L.time_period, L.candidates);
  const byWallet = new Map(rows.map((r) => [r.user_id.toLowerCase(), r]));
  for (const w of L.include) if (!byWallet.has(w.toLowerCase())) byWallet.set(w.toLowerCase(), { rank: 0, user_id: w, pnl: 0 });
  const candidates = [...byWallet.values()].filter((r) => !exclude.has(r.user_id.toLowerCase()));
  const always = new Set(L.include.map((w) => w.toLowerCase()));

  const scored = await pool(candidates, 3, async (r): Promise<Leader | null> => {
    try {
      const [stats, closed] = await Promise.all([client.userStats(r.user_id), client.closedPositions(r.user_id, 200)]);
      const decided = closed.filter((p) => Math.abs(p.realized_pnl ?? 0) >= 1);
      const wins = decided.filter((p) => (p.realized_pnl ?? 0) > 0).length;
      return {
        wallet: r.user_id,
        name: r.user_name || `${r.user_id.slice(0, 6)}…${r.user_id.slice(-4)}`,
        windowPnlUsd: r.pnl,
        markets: stats?.trades ?? 0,
        decided: decided.length,
        wins,
        winRate: decided.length ? wins / decided.length : 0,
      };
    } catch {
      return null; // one unreadable profile shouldn't stop the rest
    }
  });
  const list = scored
    .filter((l): l is Leader => !!l)
    .filter(
      (l) =>
        always.has(l.wallet.toLowerCase()) ||
        (l.markets >= L.min_markets && l.decided >= L.min_decided && l.winRate >= L.min_win_rate && l.windowPnlUsd >= L.min_profit_usd),
    )
    .sort((a, b) => b.windowPnlUsd - a.windowPnlUsd)
    .slice(0, L.max_leaders);
  return { list, considered: candidates.length, failed: scored.filter((l) => !l).length };
}

/** A trader who keeps their trades private is asked again after this long. */
const PRIVATE_TTL_SEC = 86_400;

const KALSHI_PERIOD: Record<CopyTradingConfig["kalshi_leaders"]["time_period"], KalshiPeriod> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  year: "yearly",
  all: "all_time",
};

/** How a Kalshi parlay (combo market) ended: won / lost / still open, or unknown. */
export type ComboResult = (ticker: string) => Promise<"won" | "lost" | "open" | null>;

/**
 * Who to follow on Kalshi: profitable in the window AND over their whole account, enough markets,
 * and trades they show publicly (private traders can't be copied). With `comboResult`, also how
 * their recent parlays went, so "has won before" can be checked before copying one.
 */
export async function pickKalshiLeaders(
  client: Pick<KalshiSocialClient, "leaderboard" | "metrics" | "trades">,
  cfg: CopyTradingConfig,
  comboResult?: ComboResult,
  /** Traders known to keep their trades private (not asked again); updated in place. */
  privateSince?: Record<string, number>,
  now = new Date(),
): Promise<{ list: Leader[]; considered: number; hidden: number; failed: number }> {
  const K = cfg.kalshi_leaders;
  const lower = (s: string) => s.toLowerCase();
  const exclude = new Set(K.exclude.map(lower));
  const always = new Set(K.include.map(lower));
  const nowSec = Math.floor(now.getTime() / 1000);
  if (privateSince) for (const [n, at] of Object.entries(privateSince)) if (at < nowSec - PRIVATE_TTL_SEC) delete privateSince[n];
  const rows = await client.leaderboard(KALSHI_PERIOD[K.time_period], K.candidates);
  const byNick = new Map(rows.filter((r) => !r.is_anonymous).map((r) => [lower(r.nickname), r]));
  for (const n of K.include) if (!byNick.has(lower(n))) byNick.set(lower(n), { nickname: n, value: 0, rank: 0 });
  const candidates = [...byNick.values()].filter((r) => !exclude.has(lower(r.nickname)));
  let hidden = 0;
  const shown = new Map<string, KalshiSocialTrade[]>();
  const scored = await pool(candidates, 3, async (r): Promise<Leader | "hidden" | null> => {
    try {
      if (privateSince?.[lower(r.nickname)] != null && !always.has(lower(r.nickname))) {
        hidden += 1;
        return "hidden";
      }
      const t = await client.trades(r.nickname, 100);
      if (!t.visible) {
        hidden += 1;
        if (privateSince) privateSince[lower(r.nickname)] = nowSec;
        return "hidden";
      }
      const m = await client.metrics(r.nickname);
      shown.set(r.nickname, t.trades);
      return {
        source: "kalshi",
        wallet: KALSHI_PREFIX + r.nickname,
        name: r.nickname,
        windowPnlUsd: r.value,
        markets: m?.markets ?? 0,
        decided: 0,
        wins: 0,
        winRate: 0,
        lifetimePnlUsd: m?.pnlUsd ?? 0,
      };
    } catch {
      return null;
    }
  });
  const list = scored
    .filter((l): l is Leader => !!l && l !== "hidden")
    .filter(
      (l) =>
        always.has(lower(l.name)) ||
        (l.markets >= K.min_markets && l.windowPnlUsd >= K.min_profit_usd && (l.lifetimePnlUsd ?? 0) >= K.min_lifetime_profit_usd),
    )
    .sort((a, b) => b.windowPnlUsd - a.windowPnlUsd)
    .slice(0, K.max_leaders);
  if (comboResult) {
    // Their most recent parlays (combos they bought YES on), newest first.
    await pool(list, 3, async (l) => {
      const combos = [
        ...new Set(
          (shown.get(l.name) ?? [])
            .filter((t) => isKalshiCombo(t.ticker) && t.taker_nickname === l.name && t.taker_action === "buy" && t.taker_side === "yes")
            .map((t) => t.ticker),
        ),
      ].slice(0, 12);
      // One at a time: these are Kalshi market reads, which share the paper cycle's rate limit.
      const results: Array<Awaited<ReturnType<ComboResult>>> = [];
      for (const c of combos) results.push(await comboResult(c).catch(() => null));
      l.parlays = {
        won: results.filter((r) => r === "won").length,
        lost: results.filter((r) => r === "lost").length,
        open: results.filter((r) => r === "open").length,
      };
    });
  }
  return { list, considered: candidates.length, hidden, failed: scored.filter((l) => l === null).length };
}

/** One leader bet: their fills on one market + outcome in this poll, combined. */
export interface LeaderBet {
  leader: Leader;
  side: "BUY" | "SELL";
  slug?: string;
  conditionId?: string;
  title: string;
  outcome: string;
  outcomeIndex?: number;
  /** Size-weighted average price. */
  price: number;
  shares: number;
  usd: number;
  /** Epoch seconds of the latest fill. */
  at: number;
  /** Kalshi leaders: the Kalshi market they traded (copied as is). */
  kalshiTicker?: string;
  /** That market is a Kalshi parlay (combo). */
  combo?: boolean;
}

function combine(leader: Leader, trades: TraderTrade[]): LeaderBet[] {
  const groups = new Map<string, TraderTrade[]>();
  for (const t of trades) {
    const k = `${t.side}|${t.condition_id ?? t.slug}|${t.outcome}`;
    groups.set(k, [...(groups.get(k) ?? []), t]);
  }
  return [...groups.values()].map((g) => {
    const shares = g.reduce((a, t) => a + t.size, 0);
    const cost = g.reduce((a, t) => a + t.size * t.price, 0);
    const t0 = g[0];
    return {
      leader,
      side: t0.side,
      slug: t0.slug,
      conditionId: t0.condition_id,
      title: t0.title ?? t0.slug ?? "",
      outcome: t0.outcome,
      outcomeIndex: t0.outcome_index,
      price: shares > 0 ? cost / shares : t0.price,
      shares,
      usd: cost,
      at: Math.max(...g.map((t) => t.timestamp)),
    };
  });
}

/** Re-read this much before the last fill we saw: fills can be indexed late and out of order. */
const OVERLAP_SEC = 180;
const MAX_SEEN = 4000;
const EXIT_TTL_SEC = 30 * 86_400;

const fillId = (t: TraderTrade) => `${t.transaction_hash ?? t.timestamp}|${t.side}|${t.outcome}|${t.size}|${t.price}|${t.condition_id ?? t.slug}`;

/**
 * New fills since the last poll. `wallets` are the leaders plus anyone we still hold a copy from
 * (so their sells are seen even after they drop off the leader list); `since` gives a start for a
 * wallet we haven't polled before. Records every sell in `state.exits`. Buys are returned whatever
 * their age; the caller only copies fresh ones.
 */
export async function pollLeaders(
  client: PolymarketDataClient,
  wallets: Array<{ leader: Leader; since?: number }>,
  state: CopyState,
  cfg: CopyTradingConfig,
  now: Date,
): Promise<LeaderBet[]> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const floor = nowSec - cfg.copy.max_trade_age_minutes * 60;
  const seen = new Set(state.seen);
  const bets: LeaderBet[] = [];
  await pool(wallets, 3, async ({ leader: l, since: start }) => {
    const last = state.lastSeen[l.wallet];
    const since = last != null ? last - OVERLAP_SEC : Math.min(start ?? floor, floor);
    try {
      const trades = await client.trades(l.wallet, since, 200);
      const fresh = trades.filter((t) => t.timestamp >= since && !seen.has(fillId(t)));
      for (const t of fresh) {
        seen.add(fillId(t));
        state.seen.push(fillId(t));
      }
      if (trades.length) state.lastSeen[l.wallet] = Math.max(last ?? 0, ...trades.map((t) => t.timestamp));
      bets.push(...combine(l, fresh));
    } catch {
      // try again next poll
    }
  });
  recordExits(bets, state, cfg, nowSec);
  return bets.sort((a, b) => b.at - a.at);
}

/**
 * A leader closing a bet: a sell of it, or (Kalshi) a buy of the other side of the same market,
 * which nets their position out. Remembered until old so a copy still sells on a later check.
 */
function recordExits(bets: LeaderBet[], state: CopyState, cfg: CopyTradingConfig, nowSec: number): void {
  for (const b of bets) {
    if (b.usd < cfg.copy.min_leader_trade_usd / 2) continue;
    const market = b.conditionId ?? b.slug;
    const closes = b.side === "SELL" ? b.outcome : b.kalshiTicker && !b.combo ? (/^yes$/i.test(b.outcome) ? "No" : "Yes") : undefined;
    if (!closes) continue;
    const k = betKey(b.leader.wallet, market, closes);
    state.exits[k] = Math.max(state.exits[k] ?? 0, b.at);
  }
  for (const [k, at] of Object.entries(state.exits)) if (at < nowSec - EXIT_TTL_SEC) delete state.exits[k];
  if (state.seen.length > MAX_SEEN) state.seen.splice(0, state.seen.length - MAX_SEEN);
}

/**
 * A Kalshi leader's own fills as trades: only where they took liquidity (a resting order that got
 * hit is often market making, not a view). Price is the side they bought or sold.
 */
export function kalshiFills(nickname: string, trades: KalshiSocialTrade[]): TraderTrade[] {
  return trades
    .filter((t) => t.taker_nickname === nickname)
    .map((t) => {
      const yes = Number(t.price_dollars);
      return {
        proxy_wallet: KALSHI_PREFIX + nickname,
        side: t.taker_action === "buy" ? ("BUY" as const) : ("SELL" as const),
        outcome: t.taker_side === "yes" ? "Yes" : "No",
        outcome_index: t.taker_side === "yes" ? 0 : 1,
        price: t.taker_side === "yes" ? yes : 1 - yes,
        size: Number(t.count_fp ?? t.count ?? 0),
        timestamp: Math.floor(Date.parse(t.create_date) / 1000),
        slug: t.ticker,
        title: t.ticker,
        transaction_hash: `kalshi-${t.trade_id}`,
      };
    })
    .filter((t) => Number.isFinite(t.timestamp) && t.size > 0 && t.price > 0 && t.price < 1);
}

/** New fills of Kalshi leaders since the last poll (same bookkeeping as `pollLeaders`). */
export async function pollKalshiLeaders(
  client: Pick<KalshiSocialClient, "trades">,
  wallets: Array<{ leader: Leader; since?: number }>,
  state: CopyState,
  cfg: CopyTradingConfig,
  now: Date,
): Promise<LeaderBet[]> {
  const nowSec = Math.floor(now.getTime() / 1000);
  const floor = nowSec - cfg.copy.max_trade_age_minutes * 60;
  const seen = new Set(state.seen);
  const bets: LeaderBet[] = [];
  await pool(wallets, 3, async ({ leader: l, since: start }) => {
    const last = state.lastSeen[l.wallet];
    const since = last != null ? last - OVERLAP_SEC : Math.min(start ?? floor, floor);
    try {
      const { trades: raw } = await client.trades(kalshiNick(l.wallet), 100);
      const trades = kalshiFills(kalshiNick(l.wallet), raw);
      const fresh = trades.filter((t) => t.timestamp >= since && !seen.has(fillId(t)));
      for (const t of fresh) {
        seen.add(fillId(t));
        state.seen.push(fillId(t));
      }
      if (trades.length) state.lastSeen[l.wallet] = Math.max(last ?? 0, ...trades.map((t) => t.timestamp));
      for (const b of combine(l, fresh)) bets.push({ ...b, kalshiTicker: b.slug, combo: isKalshiCombo(b.slug ?? "") });
    } catch {
      // try again next poll
    }
  });
  recordExits(bets, state, cfg, nowSec);
  return bets.sort((a, b) => b.at - a.at);
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/** "Hawks" matches "Atlanta Hawks"; every word of the shorter name must be in the longer one. */
function sameTeam(a: string, b: string): boolean {
  const wa = norm(a);
  const wb = norm(b);
  if (!wa.length || !wb.length) return false;
  const [short, long] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  return short.every((w) => long.includes(w));
}

const GAME_SLUG = /^([a-z0-9]+)-([a-z0-9]+)-([a-z0-9]+)-(\d{4}-\d{2}-\d{2})$/;

/** Polymarket US game-winner slugs for a global moneyline slug (dates can differ by a day: UTC vs local). */
export function usGameSlugs(globalSlug: string): string[] {
  const m = GAME_SLUG.exec(globalSlug);
  if (!m) return [];
  const [, league, a, b, date] = m;
  const d = new Date(`${date}T12:00:00Z`).getTime();
  return [0, -1, 1].map((k) => `aec-${league}-${a}-${b}-${new Date(d + k * 86_400_000).toISOString().slice(0, 10)}`);
}

/** Global league prefix → Kalshi's game series. */
const KALSHI_GAME_SERIES: Record<string, string> = {
  nba: "KXNBAGAME",
  nfl: "KXNFLGAME",
  nhl: "KXNHLGAME",
  mlb: "KXMLBGAME",
  wnba: "KXWNBAGAME",
  cbb: "KXNCAAMBGAME",
  cfb: "KXNCAAFGAME",
};
const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];

/** Kalshi game event tickers that could be this global moneyline (date as is or a day earlier). */
export function kalshiGameEvents(globalSlug: string): Array<{ event: string; codes: [string, string] }> {
  const m = GAME_SLUG.exec(globalSlug);
  if (!m) return [];
  const [, league, a, b, date] = m;
  const series = KALSHI_GAME_SERIES[league];
  if (!series) return [];
  const d = new Date(`${date}T12:00:00Z`).getTime();
  const out: Array<{ event: string; codes: [string, string] }> = [];
  for (const k of [0, -1]) {
    const day = new Date(d + k * 86_400_000);
    const yymmmdd = `${String(day.getUTCFullYear()).slice(2)}${MON[day.getUTCMonth()]}${String(day.getUTCDate()).padStart(2, "0")}`;
    for (const [x, y] of [[a, b], [b, a]]) out.push({ event: `${series}-${yymmmdd}${x.toUpperCase()}${y.toUpperCase()}`, codes: [a.toUpperCase(), b.toUpperCase()] });
  }
  return out;
}

/**
 * Same game on Kalshi: one market per team, ticker ending in the team's code (…ATLIND-ATL). The
 * global slug's team codes are in outcome order, which picks the team; when a Polymarket US
 * twin is known its full team names must agree with Kalshi's city names, and without one the
 * game must not be a near coin-flip (so a mix-up would show as a price disagreement).
 */
export function matchKalshiGame(
  global: NormalizedMarket,
  kalshi: NormalizedMarket[],
  codes: [string, string],
  boughtOutcome: string,
  usTwin?: NormalizedMarket,
): CopyTarget | { reason: string } {
  const gRaw = global.raw as { sportsMarketType?: string } | undefined;
  if (gRaw?.sportsMarketType !== "moneyline" || global.outcomes?.length !== 2) return { reason: "not a two-team game" };
  const [g0, g1] = global.outcomes;
  const idx = sameTeam(boughtOutcome, g0) && !sameTeam(boughtOutcome, g1) ? 0 : sameTeam(boughtOutcome, g1) && !sameTeam(boughtOutcome, g0) ? 1 : -1;
  if (idx < 0) return { reason: "couldn't tell which team was bought" };
  const [mine, theirs] = idx === 0 ? codes : [codes[1], codes[0]];
  const team = kalshi.find((m) => m.id.toUpperCase().endsWith(`-${mine}`));
  const other = kalshi.find((m) => m.id.toUpperCase().endsWith(`-${theirs}`));
  if (!team || !other || (team.status ?? "open") !== "open") return { reason: "game not open on Kalshi" };
  if (usTwin?.outcomes?.length === 2) {
    // US full names ("Atlanta Hawks") bridge Kalshi cities ("Atlanta") and global nicknames ("Hawks").
    const usTeam = usTwin.outcomes.find((n) => sameTeam(boughtOutcome, n));
    if (!usTeam || !team.subtitle || !sameTeam(team.subtitle, usTeam)) return { reason: "Kalshi's team names don't line up" };
  } else if (Math.abs(global.yesPrice - 0.5) < 0.08) {
    return { reason: "close game with no Polymarket US twin to confirm Kalshi's team names" };
  }
  return { market: team, side: "yes", how: `same game (${team.id})` };
}

export interface CopyTarget {
  market: NormalizedMarket;
  side: SignalSide;
  how: string;
}

/**
 * Same game on Polymarket US: the global moneyline's two teams must be the US market's two sides
 * and the start times within 3 hours. The side is picked by team name, never by position.
 */
export function matchGame(global: NormalizedMarket, us: NormalizedMarket[], boughtOutcome: string): CopyTarget | { reason: string } {
  const gRaw = global.raw as { sportsMarketType?: string; gameStartTime?: string; slug?: string } | undefined;
  if (gRaw?.sportsMarketType && gRaw.sportsMarketType !== "moneyline") return { reason: "only game-winner bets are copied (this is a spread / over-under / prop)" };
  if (gRaw?.sportsMarketType !== "moneyline" || global.outcomes?.length !== 2) return { reason: "not a two-team game" };
  const start = gRaw.gameStartTime ? Date.parse(gRaw.gameStartTime.replace(" ", "T").replace(/\+00$/, "Z")) : NaN;
  // Teams can meet on consecutive days (a series), so both start times are required.
  if (!Number.isFinite(start)) return { reason: "the leader's game has no start time" };
  for (const m of us) {
    const raw = m.raw as { sportsMarketType?: string; gameStartTime?: string; slug?: string } | undefined;
    if ((m.status ?? "open") !== "open") continue;
    if (!raw?.sportsMarketType?.endsWith("_winner") || m.outcomes?.length !== 2) continue;
    const usStart = raw.gameStartTime ? Date.parse(raw.gameStartTime) : NaN;
    if (!Number.isFinite(usStart) || Math.abs(start - usStart) > 3 * 3600_000) continue;
    const [g0, g1] = global.outcomes;
    const [long, short] = m.outcomes;
    const straight = sameTeam(g0, long) && sameTeam(g1, short);
    const crossed = sameTeam(g0, short) && sameTeam(g1, long);
    if (straight === crossed) continue; // no match, or ambiguous names
    const boughtFirst = sameTeam(boughtOutcome, g0) && !sameTeam(boughtOutcome, g1);
    const boughtSecond = sameTeam(boughtOutcome, g1) && !sameTeam(boughtOutcome, g0);
    if (!boughtFirst && !boughtSecond) continue;
    const longTeam = straight ? boughtFirst : boughtSecond;
    return { market: m, side: longTeam ? "yes" : "no", how: `same game (${raw.slug ?? m.id})` };
  }
  return { reason: "game not listed on Polymarket US" };
}

/** Same Yes/No question by title (the strict arbitrage matcher), on Polymarket US or Kalshi. */
export function matchTitle(
  global: NormalizedMarket,
  venue: "polymarket_us" | "kalshi",
  markets: NormalizedMarket[],
  outcome: string,
  cfg: CopyTradingConfig,
  /** `${kalshiId}|${globalId}` pairs you blocked with arb:block. */
  blocked?: Set<string>,
): CopyTarget | { reason: string } {
  if (!/^(yes|no)$/i.test(outcome)) return { reason: `bet is on "${outcome}", not Yes/No` };
  const found = findMatches(markets, [global], {
    minScore: cfg.copy.min_score,
    // Polymarket US close times are settlement deadlines, often weeks after the event.
    maxCloseGapHours: venue === "polymarket_us" ? 2400 : 168,
    leftPlatform: venue,
    exclude: venue === "kalshi" ? blocked : undefined,
  });
  const best = found.find((c) => c.ok);
  if (!best) return { reason: `no matching question on ${platformName(venue)}` };
  return { market: best.kalshi, side: /^yes$/i.test(outcome) ? "yes" : "no", how: `same question (title match ${best.score.toFixed(2)})` };
}

/** One line on why this leader is followed. */
export function leaderLine(L: Leader, cfg: CopyTradingConfig): string {
  if (L.source === "kalshi") {
    const p = L.parlays && L.parlays.won + L.parlays.lost > 0 ? `, parlays ${L.parlays.won} won / ${L.parlays.lost} lost` : "";
    return `${L.name} (Kalshi): ${usd(L.windowPnlUsd)} profit (${cfg.kalshi_leaders.time_period}), ${usd(L.lifetimePnlUsd ?? 0)} all-time, ${L.markets.toLocaleString("en-US")} markets${p}`;
  }
  return `${L.name}: ${Math.round(L.winRate * 100)}% wins over ${L.decided} results, ${L.markets.toLocaleString("en-US")} markets, ${usd(L.windowPnlUsd)} profit (${cfg.leaders.time_period})`;
}

/** Price of the side we'd hold, from the YES price. */
const sidePrice = (yes: number, side: SignalSide) => (side === "yes" ? yes : 1 - yes);

/** The checks a copy has to pass before the shared position / risk checks. */
export function copyChecks(bet: LeaderBet, global: NormalizedMarket | undefined, t: CopyTarget, cfg: CopyTradingConfig, now: Date): Check[] {
  const L = bet.leader;
  const ageMin = Math.max(0, Math.round((now.getTime() / 1000 - bet.at) / 60));
  const pay = buyPrice(t.market, t.side, cfg.paper.slippage);
  const checks: Check[] = [
    {
      stage: "filters",
      name: "Leader",
      ok: true,
      detail: leaderLine(L, cfg),
    },
    {
      stage: "filters",
      name: "Leader's bet",
      ok: bet.usd >= cfg.copy.min_leader_trade_usd && ageMin <= cfg.copy.max_trade_age_minutes,
      detail: `bought ${bet.outcome} at ${cents(bet.price)}, ${usd(bet.usd)}, ${ageMin} min ago (needs ≥ ${usd(cfg.copy.min_leader_trade_usd)}, ≤ ${cfg.copy.max_trade_age_minutes} min)`,
    },
    { stage: "filters", name: "Same market", ok: true, detail: `${t.market.title} on ${platformName(t.market.platform)} — ${t.how}` },
    {
      stage: "signal",
      name: "Price now",
      ok: pay > 0 && pay < 1 && pay <= bet.price + cfg.copy.max_chase + 1e-9 && pay >= bet.price - cfg.copy.max_discount - 1e-9,
      detail:
        pay < bet.price - cfg.copy.max_discount - 1e-9
          ? `${t.side.toUpperCase()} costs ${cents(pay)} here, ${cents(bet.price - pay)} below the leader's ${cents(bet.price)}: the price already moved against them (max ${cents(cfg.copy.max_discount)} below)`
          : `${t.side.toUpperCase()} costs ${cents(pay)} here vs the leader's ${cents(bet.price)} (max ${cents(bet.price + cfg.copy.max_chase)})`,
    },
  ];
  if (cfg.copy.pre_game_only) {
    const started = hasStarted(t.market, now);
    checks.push({
      stage: "filters",
      name: "Before the game",
      ok: started !== true,
      detail: started == null ? "no start time (not a game)" : started ? "the game has started: in-play bets aren't copied" : `starts ${new Date(t.market.startsAt!).toISOString().slice(0, 16).replace("T", " ")} UTC`,
    });
  }
  if (global) {
    // Compare the price of the bet itself on both sites; far apart means it's not really the same bet.
    const here = sidePrice(t.market.yesPrice, t.side);
    const boughtFirst = bet.outcomeIndex === 0 || /^yes$/i.test(bet.outcome) || (global.outcomes?.[0] != null && sameTeam(bet.outcome, global.outcomes[0]));
    const there = boughtFirst ? global.yesPrice : 1 - global.yesPrice;
    const gap = Math.abs(here - there);
    checks.push({
      stage: "signal",
      name: "Prices agree",
      ok: gap <= cfg.copy.max_price_gap + 1e-9,
      detail: `${cents(here)} here vs ${cents(there)} on global Polymarket (${cents(gap)} apart, max ${cents(cfg.copy.max_price_gap)})`,
    });
  }
  return checks;
}
