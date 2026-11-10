import type { NormalizedMarket } from "../types.js";

/**
 * Sharp-line comparison (pure parts). A "sharp" sportsbook's line, with the bookmaker's margin
 * taken out, is the best public estimate of a game's true odds. When Kalshi or Polymarket US sells
 * a side for clearly less than that estimate, after fees, the bet has an edge on paper.
 */

export interface SharpEvent {
  /** Provider sport key, e.g. "basketball_nba". */
  sport: string;
  home: string;
  away: string;
  /** Scheduled start, ISO. */
  start: string;
  /** Whose line this is: the sharp book, or "consensus of N books". */
  book: string;
  /** When that book last updated the line, ISO. */
  updatedAt: string;
  /** Fair win probability by outcome name (the two teams, plus "Draw" in soccer). They sum to 1. */
  fair: Record<string, number>;
}

export interface Fair {
  /** Fair probability that this market resolves YES. */
  p: number;
  book: string;
  updatedAt: string;
  /** "Buffalo Bills vs Minnesota Vikings". */
  game: string;
}

/** Remove the bookmaker's margin: implied probabilities scaled to sum to 1. */
export function devig(decimalOdds: number[]): number[] {
  const raw = decimalOdds.map((o) => (o > 1 ? 1 / o : NaN));
  const sum = raw.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(sum) || sum <= 0) return [];
  return raw.map((x) => x / sum);
}

const words = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);

/**
 * Does a short exchange name ("Los Angeles L", "Ohio St.", "Man City", "Bills") name this full team
 * ("Los Angeles Lakers", "Ohio State Buckeyes", "Manchester City", "Buffalo Bills")? Either every
 * word of the short name starts the matching word of the full name, in order from the front, or the
 * short name's words are the full name's last words (a nickname).
 */
export function namesTeam(short: string, full: string): boolean {
  const a = words(short);
  const b = words(full);
  if (!a.length || a.length > b.length) return false;
  if (a.join("").length < 3) return false;
  const front = a.every((w, i) => b[i].startsWith(w));
  const back = a.every((w, i) => b[b.length - a.length + i] === w);
  return front || back;
}

/** Kalshi game series → provider sport key. Polymarket US league slug → the same. */
export const SPORT_BY_KALSHI_SERIES: Record<string, string> = {
  KXNFLGAME: "americanfootball_nfl",
  KXNCAAFGAME: "americanfootball_ncaaf",
  KXNBAGAME: "basketball_nba",
  KXNCAAMBGAME: "basketball_ncaab",
  KXWNBAGAME: "basketball_wnba",
  KXNHLGAME: "icehockey_nhl",
  KXMLBGAME: "baseball_mlb",
  KXEPLGAME: "soccer_epl",
  KXUCLGAME: "soccer_uefa_champs_league",
  KXLALIGAGAME: "soccer_spain_la_liga",
  KXMLSGAME: "soccer_usa_mls",
};
export const SPORT_BY_US_LEAGUE: Record<string, string> = {
  nfl: "americanfootball_nfl",
  cfb: "americanfootball_ncaaf",
  nba: "basketball_nba",
  cbb: "basketball_ncaab",
  wnba: "basketball_wnba",
  nhl: "icehockey_nhl",
  mlb: "baseball_mlb",
  epl: "soccer_epl",
  ucl: "soccer_uefa_champs_league",
  mls: "soccer_usa_mls",
};

interface UsSide {
  long?: boolean;
  team?: { name?: string };
}

/** The provider sport key for a game-winner market, if it's one we can compare. */
export function sportOf(m: NormalizedMarket): string | undefined {
  if (m.platform === "kalshi") return SPORT_BY_KALSHI_SERIES[m.id.split("-")[0].toUpperCase()];
  if (m.platform === "polymarket_us") {
    const slug = (m.raw as { slug?: string } | undefined)?.slug ?? "";
    const league = /^aec-([a-z0-9]+)-/.exec(slug)?.[1];
    return league ? SPORT_BY_US_LEAGUE[league] : undefined;
  }
  return undefined;
}

const MAX_START_GAP_MS = 3 * 3600_000;

function near(m: NormalizedMarket, e: SharpEvent): boolean {
  const a = m.startsAt ? Date.parse(m.startsAt) : NaN;
  const b = Date.parse(e.start);
  return Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) <= MAX_START_GAP_MS;
}

/** The name Kalshi gives the YES side of a game market ("Portland", "Tie"). */
function kalshiSide(m: NormalizedMarket): string | undefined {
  return (m.raw as { yes_sub_title?: string } | undefined)?.yes_sub_title ?? m.subtitle;
}

/**
 * Fair YES probability for one game-winner market, or why there isn't one. Matching is strict: same
 * sport, starts within 3 hours of the book's start time, BOTH teams of the game named, and exactly
 * one such game. Anything unclear is skipped, never guessed.
 */
export function fairFor(m: NormalizedMarket, siblings: NormalizedMarket[], events: SharpEvent[]): Fair | { reason: string } {
  const sport = sportOf(m);
  if (!sport) return { reason: "not a league with a sharp line" };
  const pool = events.filter((e) => e.sport === sport && near(m, e));
  if (!pool.length) return { reason: "no sharp line for a game at this time" };
  const hits: Array<{ e: SharpEvent; outcome: string }> = [];
  if (m.platform === "polymarket_us") {
    const sides = ((m.raw as { marketSides?: UsSide[] } | undefined)?.marketSides ?? []) as UsSide[];
    const yes = sides.find((s) => s.long === true)?.team?.name;
    const no = sides.find((s) => s.long === false)?.team?.name;
    if (!yes || !no) return { reason: "the market doesn't say which teams" };
    for (const e of pool) {
      const teams = [e.home, e.away];
      const y = teams.filter((t) => namesTeam(yes, t) || namesTeam(t, yes));
      const n = teams.filter((t) => namesTeam(no, t) || namesTeam(t, no));
      if (y.length === 1 && n.length === 1 && y[0] !== n[0]) hits.push({ e, outcome: y[0] });
    }
  } else {
    const mine = kalshiSide(m);
    if (!mine) return { reason: "the market doesn't say which team" };
    const others = siblings.filter((s) => s.id !== m.id && s.eventId === m.eventId).map(kalshiSide).filter((s): s is string => !!s);
    const isTie = (s: string) => /^(tie|draw)$/i.test(s.trim());
    const teamNames = [mine, ...others].filter((s) => !isTie(s));
    if (teamNames.length !== 2) return { reason: "couldn't see both teams of this game" };
    for (const e of pool) {
      const teams = [e.home, e.away];
      const a = teams.filter((t) => namesTeam(teamNames[0], t));
      const b = teams.filter((t) => namesTeam(teamNames[1], t));
      if (a.length !== 1 || b.length !== 1 || a[0] === b[0]) continue;
      // `mine` is first in teamNames unless it's the tie market.
      hits.push({ e, outcome: isTie(mine) ? "Draw" : a[0] });
    }
  }
  if (!hits.length) return { reason: "team names don't line up with the sharp book's" };
  if (hits.length > 1) return { reason: "more than one game fits: skipped" };
  const { e, outcome } = hits[0];
  const p = e.fair[outcome];
  if (!(p > 0 && p < 1)) return { reason: "the sharp book has no price for this side" };
  return { p, book: e.book, updatedAt: e.updatedAt, game: `${e.away} at ${e.home}` };
}
