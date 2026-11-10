import { devig, type SharpEvent } from "./sharp.js";

/**
 * The Odds API (the-odds-api.com), v4 odds endpoint. Read-only. The key comes from ODDS_API_KEY in
 * `.env`; it goes in the request's query string (the API's design) and is never logged or put in an
 * error message. One request = one sport, one region, one market = 1 usage credit.
 */

const BASE = "https://api.the-odds-api.com/v4";

interface RawOutcome {
  name?: string;
  price?: number;
}
interface RawBook {
  key?: string;
  last_update?: string;
  markets?: Array<{ key?: string; last_update?: string; outcomes?: RawOutcome[] }>;
}
export interface RawOddsEvent {
  sport_key?: string;
  commence_time?: string;
  home_team?: string;
  away_team?: string;
  bookmakers?: RawBook[];
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

/** A book's head-to-head line with the margin removed, by outcome name. */
function bookFair(b: RawBook): { fair: Record<string, number>; at: string } | undefined {
  const h2h = b.markets?.find((m) => m.key === "h2h");
  const outs = (h2h?.outcomes ?? []).filter((o): o is { name: string; price: number } => !!o.name && typeof o.price === "number" && o.price > 1);
  if (outs.length < 2 || outs.length > 3) return undefined;
  const probs = devig(outs.map((o) => o.price));
  if (probs.length !== outs.length) return undefined;
  return { fair: Object.fromEntries(outs.map((o, i) => [o.name, probs[i]])), at: h2h?.last_update ?? b.last_update ?? "" };
}

/**
 * Provider rows → events with fair probabilities. The sharp book's own line when it's there;
 * otherwise the median of at least `minBooks` other books (labelled as a consensus).
 */
export function parseOddsEvents(rows: RawOddsEvent[], sharpBook = "pinnacle", minBooks = 4): SharpEvent[] {
  const out: SharpEvent[] = [];
  for (const r of rows) {
    if (!r.sport_key || !r.home_team || !r.away_team || !r.commence_time) continue;
    const books = (r.bookmakers ?? []).map((b) => ({ key: b.key ?? "", line: bookFair(b) })).filter((b): b is { key: string; line: NonNullable<ReturnType<typeof bookFair>> } => !!b.line);
    const sharp = books.find((b) => b.key === sharpBook);
    let fair: Record<string, number> | undefined;
    let book = "";
    let updatedAt = "";
    if (sharp) {
      fair = sharp.line.fair;
      book = sharpBook;
      updatedAt = sharp.line.at;
    } else if (books.length >= minBooks) {
      const names = Object.keys(books[0].line.fair);
      const same = books.filter((b) => names.every((n) => n in b.line.fair) && Object.keys(b.line.fair).length === names.length);
      if (same.length >= minBooks) {
        const med = names.map((n) => median(same.map((b) => b.line.fair[n])));
        const sum = med.reduce((a, b) => a + b, 0);
        fair = Object.fromEntries(names.map((n, i) => [n, med[i] / sum]));
        book = `consensus of ${same.length} books`;
        updatedAt = same.map((b) => b.line.at).sort()[0]; // the oldest of them: be conservative about freshness
      }
    }
    if (!fair || !updatedAt) continue;
    out.push({ sport: r.sport_key, home: r.home_team, away: r.away_team, start: r.commence_time, book, updatedAt, fair });
  }
  return out;
}

export interface OddsFetchResult {
  events: SharpEvent[];
  /** Credits this request cost and how many are left this month, when the API says. */
  cost?: number;
  remaining?: number;
}

export class OddsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
  ) {
    super(message);
  }
}

export type FetchLike = (url: string) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; json(): Promise<unknown> }>;

export async function fetchOdds(sport: string, key: string, opts: { region?: string; book?: string; fetchImpl?: FetchLike } = {}): Promise<OddsFetchResult> {
  const url = new URL(`${BASE}/sports/${encodeURIComponent(sport)}/odds`);
  url.searchParams.set("regions", opts.region ?? "eu");
  url.searchParams.set("markets", "h2h");
  url.searchParams.set("oddsFormat", "decimal");
  url.searchParams.set("dateFormat", "iso");
  url.searchParams.set("apiKey", key);
  const doFetch: FetchLike = opts.fetchImpl ?? ((u) => fetch(u, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(20_000) }));
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await doFetch(url.toString());
  } catch {
    // The underlying error can carry the URL (and so the key): never pass it on.
    throw new OddsApiError("couldn't reach the odds service", 0);
  }
  const num = (h: string) => {
    const v = Number(res.headers.get(h));
    return Number.isFinite(v) && res.headers.get(h) != null ? v : undefined;
  };
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error_code?: string; message?: string };
    const code = body.error_code;
    const why =
      code === "OUT_OF_USAGE_CREDITS" ? "this month's free requests are used up" : code === "INVALID_KEY" || code === "MISSING_KEY" || code === "DEACTIVATED_KEY" ? "the key in ODDS_API_KEY isn't valid" : code === "UNKNOWN_SPORT" || code === "INVALID_SPORT" ? `no such sport (${sport})` : `HTTP ${res.status}${code ? ` ${code}` : ""}`;
    throw new OddsApiError(why, res.status, code);
  }
  const rows = (await res.json()) as RawOddsEvent[];
  return { events: parseOddsEvents(Array.isArray(rows) ? rows : [], opts.book ?? "pinnacle"), cost: num("x-requests-last"), remaining: num("x-requests-remaining") };
}
