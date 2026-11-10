import type { NormalizedMarket } from "../types.js";

/**
 * Exact Kalshi ↔ Polymarket US twins, from the platforms' own identifiers (no title guessing).
 *
 *  - Games: Kalshi `KXNBAGAME-26NOV04PHIDET-PHI` ↔ Polymarket US `aec-nba-phi-det-2026-11-04`.
 *    League, date and BOTH teams must agree, each by abbreviation AND by name, so a pair can't
 *    come out flipped (that would be two bets on the same team). Same payout rule on both
 *    sites (the team wins the game), so these trade like pairs you confirmed.
 *    NFL is left out: a tie can settle differently on the two sites.
 *  - Elections: Kalshi `SENATETX-26-R` / `GOVPARTYOH-26-R` / `HOUSETX15-26-D` ↔ Polymarket US
 *    `ewc-usse-tx-2026-11-03-rep` and friends, by office, state, district, year and party. The
 *    sites word the payout differently (Kalshi: the party's candidate is sworn in; Polymarket US:
 *    the party's nominee wins), so these only alert until you confirm them.
 */

export interface ExactPair {
  kalshi: NormalizedMarket;
  us: NormalizedMarket;
  /** "line" = the same full-game point spread or total. */
  kind: "game" | "election" | "line";
  /** Plain-English reason they're the same question. */
  how: string;
  /** Polymarket US YES is the same bet as Kalshi NO (a spread quoted from the other team's side). */
  invert?: boolean;
}

/** Kalshi game series → Polymarket US league slug. (No NFL: ties.) */
export const GAME_SERIES: Record<string, string> = {
  KXNBAGAME: "nba",
  KXNHLGAME: "nhl",
  KXMLBGAME: "mlb",
  KXWNBAGAME: "wnba",
  KXNCAAMBGAME: "cbb",
  KXNCAAFGAME: "cfb",
};

const MON = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ").trim();

interface UsSide {
  long?: boolean;
  description?: string;
  team?: { abbreviation?: string; name?: string };
}
const usRaw = (m: NormalizedMarket) => (m.raw ?? {}) as { slug?: string; sportsMarketTypeV2?: string; marketSides?: UsSide[]; description?: string; question?: string };

/** `KXNBAGAME-26NOV04PHIDET` → league, date and the team-code string (MLB adds a start time). */
export function parseGameEvent(eventTicker: string): { series: string; date: string; teams: string } | null {
  const m = /^([A-Z0-9]+)-(\d{2})([A-Z]{3})(\d{2})(?:\d{4})?([A-Z]+)$/.exec(eventTicker);
  if (!m) return null;
  const [, series, yy, mon, dd, teams] = m;
  const month = MON.indexOf(mon);
  if (month < 0 || !GAME_SERIES[series]) return null;
  return { series, date: `20${yy}-${String(month + 1).padStart(2, "0")}-${dd}`, teams };
}

/** Polymarket US slugs a Kalshi game event could be listed under (both team orders; both use the local game date). */
export function usSlugsForGame(eventTicker: string, codes: string[]): string[] {
  const g = parseGameEvent(eventTicker);
  if (!g || codes.length !== 2) return [];
  const league = GAME_SERIES[g.series];
  const [a, b] = codes.map((c) => c.toLowerCase());
  return [`aec-${league}-${a}-${b}-${g.date}`, `aec-${league}-${b}-${a}-${g.date}`];
}

/** The team code at the end of a Kalshi game market ticker (`…-PHI`). */
const codeOf = (m: NormalizedMarket) => m.id.slice(m.id.lastIndexOf("-") + 1).toUpperCase();

/**
 * Match Kalshi game markets (grouped by event) with Polymarket US moneylines. Returns one pair per
 * game: the Kalshi market for the team that is YES on Polymarket US.
 */
export function matchGames(kalshi: NormalizedMarket[], us: NormalizedMarket[]): ExactPair[] {
  const bySlug = new Map(us.map((m) => [usRaw(m).slug ?? "", m]));
  const events = new Map<string, NormalizedMarket[]>();
  for (const m of kalshi) {
    if (!m.eventId || (m.status ?? "open") !== "open") continue;
    events.set(m.eventId, [...(events.get(m.eventId) ?? []), m]);
  }
  const out: ExactPair[] = [];
  for (const [event, markets] of events) {
    if (markets.length !== 2) continue; // two teams, no draw market
    const codes = markets.map(codeOf);
    const twins = usSlugsForGame(event, codes).map((s) => bySlug.get(s)).filter((m): m is NormalizedMarket => !!m);
    for (const u of twins) {
      const raw = usRaw(u);
      if (raw.sportsMarketTypeV2 !== "SPORTS_MARKET_TYPE_MONEYLINE" || (u.status ?? "open") !== "open") continue;
      const long = raw.marketSides?.find((s) => s.long === true)?.team;
      const short = raw.marketSides?.find((s) => s.long === false)?.team;
      if (!long?.abbreviation || !long.name || !short?.abbreviation || !short.name) continue;
      const kLong = markets.find((m) => codeOf(m) === long.abbreviation!.toUpperCase());
      const kShort = markets.find((m) => codeOf(m) === short.abbreviation!.toUpperCase());
      if (!kLong || !kShort || kLong === kShort) continue;
      // Names too: Kalshi says "Philadelphia" / "Los Angeles L", Polymarket US "Philadelphia 76ers" / "Los Angeles Lakers".
      const named = (k: NormalizedMarket, team: string) => {
        const sub = (k.raw as { yes_sub_title?: string } | undefined)?.yes_sub_title ?? k.subtitle;
        return !!sub && norm(sub).length >= 3 && norm(team).startsWith(norm(sub));
      };
      if (!named(kLong, long.name) || !named(kShort, short.name)) continue;
      out.push({ kalshi: kLong, us: u, kind: "game", how: `same game: ${long.name} vs ${short.name} on ${parseGameEvent(event)!.date} (${kLong.id})` });
      break;
    }
  }
  return out;
}

const STATES: Record<string, string> = {
  al: "alabama", ak: "alaska", az: "arizona", ar: "arkansas", ca: "california", co: "colorado", ct: "connecticut",
  de: "delaware", fl: "florida", ga: "georgia", hi: "hawaii", id: "idaho", il: "illinois", in: "indiana", ia: "iowa",
  ks: "kansas", ky: "kentucky", la: "louisiana", me: "maine", md: "maryland", ma: "massachusetts", mi: "michigan",
  mn: "minnesota", ms: "mississippi", mo: "missouri", mt: "montana", ne: "nebraska", nv: "nevada", nh: "new hampshire",
  nj: "new jersey", nm: "new mexico", ny: "new york", nc: "north carolina", nd: "north dakota", oh: "ohio",
  ok: "oklahoma", or: "oregon", pa: "pennsylvania", ri: "rhode island", sc: "south carolina", sd: "south dakota",
  tn: "tennessee", tx: "texas", ut: "utah", vt: "vermont", va: "virginia", wa: "washington", wv: "west virginia",
  wi: "wisconsin", wy: "wyoming",
};

/** `ewc-usse-tx-2026-11-03-rep` / `usgubewc-usgub-oh-…` / `ushrewc-ushr-tx-15-…` → the race. */
export function parseUsRace(slug: string): { office: "senate" | "governor" | "house"; state: string; district?: number; year: number; party: "R" | "D" } | null {
  const m = /^(?:[a-z]+-)?(usse|usgub|ushr)-([a-z]{2})(?:-(\d{1,2}))?-(\d{4})-\d{2}-\d{2}-(rep|dem)$/.exec(slug);
  if (!m || !STATES[m[2]]) return null;
  const office = m[1] === "usse" ? "senate" : m[1] === "usgub" ? "governor" : "house";
  if ((office === "house") !== (m[3] != null)) return null;
  return { office, state: m[2], district: m[3] != null ? Number(m[3]) : undefined, year: Number(m[4]), party: m[5] === "rep" ? "R" : "D" };
}

/** Kalshi tickers for a race (House districts may or may not have a leading zero). */
export function kalshiTickersForRace(r: NonNullable<ReturnType<typeof parseUsRace>>): string[] {
  const st = r.state.toUpperCase();
  const yy = String(r.year).slice(2);
  if (r.office === "senate") return [`SENATE${st}-${yy}-${r.party}`];
  if (r.office === "governor") return [`GOVPARTY${st}-${yy}-${r.party}`];
  const d = r.district!;
  return [...new Set([`HOUSE${st}${d}-${yy}-${r.party}`, `HOUSE${st}${String(d).padStart(2, "0")}-${yy}-${r.party}`])];
}

/** Match Polymarket US race markets with the Kalshi markets fetched for them (checks wording too). */
export function matchElections(us: NormalizedMarket[], kalshi: NormalizedMarket[]): ExactPair[] {
  const byId = new Map(kalshi.map((m) => [m.id.toUpperCase(), m]));
  const out: ExactPair[] = [];
  for (const u of us) {
    const raw = usRaw(u);
    const race = raw.slug ? parseUsRace(raw.slug) : null;
    if (!race || (u.status ?? "open") !== "open") continue;
    const k = kalshiTickersForRace(race).map((t) => byId.get(t)).find((m) => m && (m.status ?? "open") === "open");
    if (!k) continue;
    const state = STATES[race.state];
    const party = race.party === "R" ? "republican" : "democrat";
    const office = race.office === "senate" ? "senat" : race.office === "governor" ? "governor" : "house";
    // Both sides must say the same party, state and office in their own words.
    const kText = norm(`${k.title} ${k.subtitle ?? ""}`);
    const uText = norm(`${raw.question ?? u.title} ${raw.description ?? ""}`);
    if (!kText.includes(party) || !uText.includes(party)) continue;
    if (race.office !== "house" && (!kText.includes(state) || !uText.includes(state))) continue;
    if (!kText.includes(office) || !(uText.includes(office) || (race.office === "house" && uText.includes("representative")))) continue;
    if (!uText.includes(String(race.year))) continue;
    const where = race.office === "house" ? `${race.state.toUpperCase()}-${race.district}` : state.replace(/\b\w/g, (c) => c.toUpperCase());
    out.push({
      kalshi: k,
      us: u,
      kind: "election",
      how: `same race: ${where} ${race.office} ${race.year}, ${race.party === "R" ? "Republican" : "Democrat"} (Kalshi pays when they're sworn in, Polymarket US when the nominee wins)`,
    });
  }
  return out;
}

export interface ExactSources {
  /** One Kalshi event's markets (public read), for a game's spread and total lines. */
  kalshiEvent?: (eventTicker: string) => Promise<NormalizedMarket[]>;
  /** Open Kalshi markets in a series (public read). */
  kalshiSeries?: (series: string) => Promise<NormalizedMarket[]>;
  /** Kalshi markets by ticker. */
  kalshiTickers?: (tickers: string[]) => Promise<NormalizedMarket[]>;
  /** Polymarket US markets by slug. */
  usSlugs?: (slugs: string[]) => Promise<NormalizedMarket[]>;
}

/** Look both kinds up. `usListed` are Polymarket US markets already fetched this cycle (for races). */
export async function findExactPairs(src: ExactSources, usListed: NormalizedMarket[], pauseMs = 300, lines?: { now: Date }): Promise<ExactPair[]> {
  const out: ExactPair[] = [];
  if (src.kalshiSeries && src.usSlugs) {
    const kalshi: NormalizedMarket[] = [];
    for (const series of Object.keys(GAME_SERIES)) {
      kalshi.push(...(await src.kalshiSeries(series)));
      if (pauseMs) await new Promise((r) => setTimeout(r, pauseMs));
    }
    const events = new Map<string, string[]>();
    for (const m of kalshi) if (m.eventId) events.set(m.eventId, [...(events.get(m.eventId) ?? []), codeOf(m)]);
    const slugs = [...events].flatMap(([e, codes]) => (codes.length === 2 ? usSlugsForGame(e, codes) : []));
    const us = slugs.length ? await src.usSlugs(slugs) : [];
    out.push(...matchGames(kalshi, us));
    if (lines && src.kalshiEvent && src.kalshiTickers) {
      try {
        out.push(...(await findLinePairs(src, kalshi, us, lines.now, pauseMs)));
      } catch {
        // A failed line lookup (rate limit, timeout) must not cost this cycle its game pairs.
      }
    }
  }
  if (src.kalshiTickers) {
    const races = usListed.filter((m) => m.platform === "polymarket_us" && parseUsRace(usRaw(m).slug ?? ""));
    const tickers = [...new Set(races.flatMap((m) => kalshiTickersForRace(parseUsRace(usRaw(m).slug!)!)))];
    const kalshi = tickers.length ? await src.kalshiTickers(tickers) : [];
    out.push(...matchElections(races, kalshi));
  }
  return out;
}


// ---- Spreads and totals ---------------------------------------------------------------------
//
// Kalshi `KXNBASPREAD-26NOV10OKCPOR-POR9` ("Portland wins by over 8.5 points") and
// `KXNBATOTAL-26NOV10OKCPOR-255` ("Over 254.5 points") ↔ Polymarket US
// `asc-nba-okc-por-2026-11-10-neg-8pt5` / `…-pos-8pt5` and `tsc-nba-okc-por-2026-11-10-254pt5`.
// Both sites count overtime, score an NHL shootout as one goal, and settle to a fair price if the
// game isn't played within two days. Lines end in .5, so there are no pushes (and no NFL tie
// problem). Only FULL-GAME lines are matched: Polymarket US also lists halves, quarters and team
// totals under the same market types, and those must never be paired with a full-game line.

/** Polymarket US league → Kalshi's winner / spread / total series. */
export const LINE_SERIES: Record<string, { game: string; spread: string; total: string }> = {
  nba: { game: "KXNBAGAME", spread: "KXNBASPREAD", total: "KXNBATOTAL" },
  nhl: { game: "KXNHLGAME", spread: "KXNHLSPREAD", total: "KXNHLTOTAL" },
  nfl: { game: "KXNFLGAME", spread: "KXNFLSPREAD", total: "KXNFLTOTAL" },
  cfb: { game: "KXNCAAFGAME", spread: "KXNCAAFSPREAD", total: "KXNCAAFTOTAL" },
  cbb: { game: "KXNCAAMBGAME", spread: "KXNCAAMBSPREAD", total: "KXNCAAMBTOTAL" },
};

/** One game on both sites, with each team's code and both sites' names for it. */
export interface GameTwin {
  league: string;
  /** Kalshi's date + teams code, e.g. 26NOV10OKCPOR. */
  matchCode: string;
  /** Polymarket US slug without its type prefix, e.g. nba-okc-por-2026-11-10. */
  base: string;
  /** Start time from Polymarket US (exact). */
  startsAt?: string;
  teams: Array<{ code: string; kalshiName: string; usName: string }>;
}

const kalshiSub = (k: NormalizedMarket) => (k.raw as { yes_sub_title?: string } | undefined)?.yes_sub_title ?? k.subtitle ?? "";
const namedBy = (sub: string, team: string) => norm(sub).length >= 3 && norm(team).startsWith(norm(sub));

/**
 * Games listed on both sites: Kalshi winner markets (two per game) and Polymarket US moneylines,
 * agreeing on league, date and both teams by abbreviation AND by name (as in matchGames, plus NFL).
 */
export function gameTwins(kalshiGames: NormalizedMarket[], usMoneylines: NormalizedMarket[]): GameTwin[] {
  const seriesLeague = new Map(Object.entries(LINE_SERIES).map(([league, s]) => [s.game, league]));
  const bySlug = new Map(usMoneylines.map((m) => [usRaw(m).slug ?? "", m]));
  const events = new Map<string, NormalizedMarket[]>();
  for (const m of kalshiGames) if (m.eventId && (m.status ?? "open") === "open") events.set(m.eventId, [...(events.get(m.eventId) ?? []), m]);
  const out: GameTwin[] = [];
  for (const [event, markets] of events) {
    const parsed = /^([A-Z0-9]+)-((\d{2})([A-Z]{3})(\d{2})(?:\d{4})?[A-Z]+)$/.exec(event);
    const league = parsed && seriesLeague.get(parsed[1]);
    if (!parsed || !league || markets.length !== 2) continue;
    const month = MON.indexOf(parsed[4]);
    if (month < 0) continue;
    const date = `20${parsed[3]}-${String(month + 1).padStart(2, "0")}-${parsed[5]}`;
    const [a, b] = markets.map((m) => codeOf(m).toLowerCase());
    for (const base of [`${league}-${a}-${b}-${date}`, `${league}-${b}-${a}-${date}`]) {
      const u = bySlug.get(`aec-${base}`);
      if (!u || (u.status ?? "open") !== "open" || usRaw(u).sportsMarketTypeV2 !== "SPORTS_MARKET_TYPE_MONEYLINE") continue;
      const sides = (usRaw(u).marketSides ?? []).map((s) => s.team).filter((t): t is { abbreviation: string; name: string } => !!t?.abbreviation && !!t.name);
      if (sides.length !== 2) continue;
      const teams = markets.map((k) => {
        const t = sides.find((x) => x.abbreviation.toUpperCase() === codeOf(k));
        return t && namedBy(kalshiSub(k), t.name) ? { code: codeOf(k), kalshiName: kalshiSub(k), usName: t.name } : undefined;
      });
      if (teams.some((t) => !t) || teams[0]!.code === teams[1]!.code) continue;
      out.push({ league, matchCode: parsed[2], base, startsAt: u.startsAt, teams: teams as GameTwin["teams"] });
      break;
    }
  }
  return out;
}

const half = (x: number) => Number.isFinite(x) && Math.abs((Math.abs(x) % 1) - 0.5) < 1e-9;
const pt = (x: number) => `${Math.floor(Math.abs(x))}pt5`;
const strikeOf = (k: NormalizedMarket) => Number((k.raw as { floor_strike?: number | string; strike_type?: string } | undefined)?.floor_strike);
const greater = (k: NormalizedMarket) => (k.raw as { strike_type?: string } | undefined)?.strike_type === "greater";

/** A Kalshi spread market of this game → the team that must win by more than `line`. */
function kalshiSpread(k: NormalizedMarket, twin: GameTwin): { team: GameTwin["teams"][number]; other: GameTwin["teams"][number]; line: number } | undefined {
  const m = /^([A-Z]+?)(\d+)$/.exec(codeOf(k));
  const line = strikeOf(k);
  const team = m && twin.teams.find((t) => t.code === m[1]);
  if (!m || !team || !greater(k) || !half(line) || line <= 0) return undefined;
  // "Portland wins by over 8.5 points": Kalshi's own name for the team, and the same number.
  const title = norm(k.title);
  if (!title.startsWith(norm(team.kalshiName)) || !title.includes(`wins by over ${Math.floor(line)}5 `) || /half|quarter|period|inning/.test(title)) return undefined;
  return { team, other: twin.teams.find((t) => t !== team)!, line };
}

/** A Kalshi full-game total of this game → the line. */
function kalshiTotal(k: NormalizedMarket): number | undefined {
  const line = strikeOf(k);
  const title = norm(k.title);
  if (!greater(k) || !half(line) || line <= 0 || !/^\d+$/.test(codeOf(k))) return undefined;
  if (!title.includes(`over ${Math.floor(line)}5`) || /half|quarter|period|inning|\b[1-4]q\b|\b[12]h\b/.test(title)) return undefined;
  return line;
}

/** Polymarket US slugs that could be the same line (the team quoted first varies by game). */
export function lineSlugs(twin: GameTwin, kalshiLines: NormalizedMarket[]): string[] {
  const out = new Set<string>();
  for (const k of kalshiLines) {
    const s = kalshiSpread(k, twin);
    if (s) for (const sign of ["neg", "pos"]) out.add(`asc-${twin.base}-${sign}-${pt(s.line)}`);
    const t = s ? undefined : kalshiTotal(k);
    if (t != null) for (const mid of ["", "total-"]) out.add(`tsc-${twin.base}-${mid}${pt(t)}`);
  }
  return [...out];
}

interface UsLineRaw {
  slug?: string;
  line?: number | string;
  sportsMarketType?: string;
  sportsMarketTypeV2?: string;
  marketSides?: Array<{ long?: boolean; description?: string; team?: { abbreviation?: string } }>;
}

/**
 * Pair this game's Kalshi spread / total markets with Polymarket US full-game lines. Every pair
 * must agree on the game, the kind of line, the number and (for spreads) which team it is about.
 */
export function matchLines(twin: GameTwin, kalshiLines: NormalizedMarket[], usLines: NormalizedMarket[]): ExactPair[] {
  const out: ExactPair[] = [];
  const us = usLines
    .filter((u) => (u.status ?? "open") === "open")
    .map((u) => ({ u, raw: (u.raw ?? {}) as UsLineRaw }))
    // Full game only: nothing between the date and the line in the slug, and the type says so.
    .filter(({ raw }) => /full_game/.test(raw.sportsMarketType ?? "") && half(Number(raw.line)));
  for (const k of kalshiLines) {
    if ((k.status ?? "open") !== "open") continue;
    const s = kalshiSpread(k, twin);
    if (s) {
      for (const { u, raw } of us) {
        if (raw.sportsMarketTypeV2 !== "SPORTS_MARKET_TYPE_SPREAD") continue;
        const long = raw.marketSides?.find((x) => x.long === true)?.team?.abbreviation?.toUpperCase();
        const line = Number(raw.line);
        // "T covers −X.5" is the same bet; "the other team covers +X.5" is the opposite bet.
        const same = raw.slug === `asc-${twin.base}-neg-${pt(s.line)}` && long === s.team.code && line === -s.line;
        const opposite = raw.slug === `asc-${twin.base}-pos-${pt(s.line)}` && long === s.other.code && line === s.line;
        if (!same && !opposite) continue;
        out.push({ kalshi: k, us: u, kind: "line", invert: opposite, how: `same spread: ${s.team.usName} by more than ${s.line} (${k.id} ↔ ${raw.slug}${opposite ? ", quoted from the other side" : ""})` });
      }
      continue;
    }
    const t = kalshiTotal(k);
    if (t == null) continue;
    for (const { u, raw } of us) {
      if (raw.sportsMarketTypeV2 !== "SPORTS_MARKET_TYPE_TOTAL" || Number(raw.line) !== t) continue;
      if (raw.slug !== `tsc-${twin.base}-${pt(t)}` && raw.slug !== `tsc-${twin.base}-total-${pt(t)}`) continue;
      if (!/^over$/i.test(raw.marketSides?.find((x) => x.long === true)?.description ?? "")) continue;
      out.push({ kalshi: k, us: u, kind: "line", how: `same total: over ${t} in ${twin.teams[0].usName} vs ${twin.teams[1].usName} (${k.id} ↔ ${raw.slug})` });
    }
  }
  return out;
}

/** Which lines exist on both sites is re-checked this often; their prices are read every time. */
const LINE_REFRESH_MS = 10 * 60_000;
/** Lines are only looked for on games starting within this long, soonest first, this many games. */
const LINE_WINDOW_MS = 36 * 3600_000;
const LINE_MAX_GAMES = 20;
const LINE_MAX_SPREAD = 0.15;
let lineCache: { at: number; pairs: Array<{ kalshiId: string; usSlug: string; invert?: boolean; how: string; startsAt: number }> } | undefined;

export function clearLineCache(): void {
  lineCache = undefined;
}

/**
 * Spread / total twins for games that haven't started. Finding them costs a few requests per game,
 * so the list is cached for ten minutes; every call re-reads the prices of the cached pairs.
 */
export async function findLinePairs(src: ExactSources, kalshiGames: NormalizedMarket[], usMoneylines: NormalizedMarket[], now: Date, pauseMs = 300): Promise<ExactPair[]> {
  const nowMs = now.getTime();
  const pause = () => (pauseMs ? new Promise((r) => setTimeout(r, pauseMs)) : Promise.resolve());
  if (!lineCache || nowMs - lineCache.at >= LINE_REFRESH_MS || nowMs < lineCache.at) {
    // NFL winners aren't arbitraged (ties), but its spreads and totals can be: fetch its games here.
    const games = [...kalshiGames];
    const moneylines = [...usMoneylines];
    if (src.kalshiSeries && src.usSlugs && !games.some((m) => m.id.startsWith(`${LINE_SERIES.nfl.game}-`))) {
      const nfl = await src.kalshiSeries(LINE_SERIES.nfl.game);
      games.push(...nfl);
      const events = new Map<string, string[]>();
      for (const m of nfl) if (m.eventId) events.set(m.eventId, [...(events.get(m.eventId) ?? []), codeOf(m).toLowerCase()]);
      const slugs: string[] = [];
      for (const [e, codes] of events) {
        const p = /^[A-Z0-9]+-(\d{2})([A-Z]{3})(\d{2})/.exec(e);
        if (!p || codes.length !== 2 || MON.indexOf(p[2]) < 0) continue;
        const date = `20${p[1]}-${String(MON.indexOf(p[2]) + 1).padStart(2, "0")}-${p[3]}`;
        slugs.push(`aec-nfl-${codes[0]}-${codes[1]}-${date}`, `aec-nfl-${codes[1]}-${codes[0]}-${date}`);
      }
      if (slugs.length) moneylines.push(...(await src.usSlugs(slugs)));
    }
    const twins = gameTwins(games, moneylines)
      .filter((t) => t.startsAt && Date.parse(t.startsAt) > nowMs && Date.parse(t.startsAt) - nowMs <= LINE_WINDOW_MS)
      .sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!))
      .slice(0, LINE_MAX_GAMES);
    const pairs: NonNullable<typeof lineCache>["pairs"] = [];
    for (const twin of twins) {
      const series = LINE_SERIES[twin.league];
      const kLines: NormalizedMarket[] = [];
      for (const s of [series.spread, series.total]) {
        kLines.push(...(await src.kalshiEvent!(`${s}-${twin.matchCode}`)));
        await pause();
      }
      // Only lines someone is actually quoting on Kalshi.
      const live = kLines.filter((k) => (k.status ?? "open") === "open" && k.yesBid != null && k.yesAsk != null && k.yesBid > 0 && k.yesAsk < 1 && k.yesAsk - k.yesBid <= LINE_MAX_SPREAD);
      const slugs = lineSlugs(twin, live);
      if (!slugs.length) continue;
      const usLines = await src.usSlugs!(slugs);
      await pause();
      for (const p of matchLines(twin, live, usLines)) pairs.push({ kalshiId: p.kalshi.id, usSlug: usRaw(p.us).slug!, invert: p.invert, how: p.how, startsAt: Date.parse(twin.startsAt!) });
    }
    lineCache = { at: nowMs, pairs };
  }
  // Fresh prices for the cached pairs whose game hasn't started.
  const open = lineCache.pairs.filter((p) => p.startsAt > nowMs);
  if (!open.length) return [];
  const kNow = new Map((await src.kalshiTickers!([...new Set(open.map((p) => p.kalshiId))])).map((m) => [m.id, m]));
  const uNow = new Map((await src.usSlugs!([...new Set(open.map((p) => p.usSlug))])).map((m) => [usRaw(m).slug ?? "", m]));
  const out: ExactPair[] = [];
  for (const p of open) {
    const k = kNow.get(p.kalshiId);
    const u = uNow.get(p.usSlug);
    if (k && u && (k.status ?? "open") === "open" && (u.status ?? "open") === "open") out.push({ kalshi: k, us: u, kind: "line", invert: p.invert, how: p.how });
  }
  return out;
}
