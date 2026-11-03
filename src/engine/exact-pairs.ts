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
  kind: "game" | "election";
  /** Plain-English reason they're the same question. */
  how: string;
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
  /** Open Kalshi markets in a series (public read). */
  kalshiSeries?: (series: string) => Promise<NormalizedMarket[]>;
  /** Kalshi markets by ticker. */
  kalshiTickers?: (tickers: string[]) => Promise<NormalizedMarket[]>;
  /** Polymarket US markets by slug. */
  usSlugs?: (slugs: string[]) => Promise<NormalizedMarket[]>;
}

/** Look both kinds up. `usListed` are Polymarket US markets already fetched this cycle (for races). */
export async function findExactPairs(src: ExactSources, usListed: NormalizedMarket[], pauseMs = 300): Promise<ExactPair[]> {
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
  }
  if (src.kalshiTickers) {
    const races = usListed.filter((m) => m.platform === "polymarket_us" && parseUsRace(usRaw(m).slug ?? ""));
    const tickers = [...new Set(races.flatMap((m) => kalshiTickersForRace(parseUsRace(usRaw(m).slug!)!)))];
    const kalshi = tickers.length ? await src.kalshiTickers(tickers) : [];
    out.push(...matchElections(races, kalshi));
  }
  return out;
}
