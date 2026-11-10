import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getJson } from "../platforms/http.js";
import { KALSHI_GAME_SERIES, kalshiTimes } from "../platforms/kalshi.js";

/**
 * The backtest lab's data: Kalshi's settled game-winner markets with their hourly pre-game quotes.
 * Public, read-only history, kept in one local file so the lab can test ideas instantly.
 */

/** One side of one game. Short keys: there are thousands of these in the file. */
export interface LabMarket {
  /** Ticker. */
  t: string;
  /** Event ticker (the game). */
  e: string;
  /** Series (the league). */
  s: string;
  /** Who YES is ("Boston", "Tie"). */
  n: string;
  /** The game's title. */
  q: string;
  /** 1 = this side won. */
  r: 0 | 1;
  /** Game start, epoch ms. */
  st: number;
  /** Hourly quotes before the start, flat triples: hours before start, bid, ask (tenths of a cent). */
  p: number[];
}

export interface LabData {
  version: 1;
  fetchedAt: string;
  markets: LabMarket[];
}

export const LEAGUE_LABEL: Record<string, string> = {
  KXNFLGAME: "NFL",
  KXNCAAFGAME: "College football",
  KXNBAGAME: "NBA",
  KXNCAAMBGAME: "College basketball",
  KXWNBAGAME: "WNBA",
  KXNHLGAME: "NHL",
  KXMLBGAME: "MLB",
  KXEPLGAME: "Premier League",
  KXUCLGAME: "Champions League",
  KXLALIGAGAME: "La Liga",
  KXMLSGAME: "MLS",
};

export function labPathFor(ledgerPath: string): string {
  return path.join(path.dirname(ledgerPath), "lab-games.json");
}

export async function loadLab(file: string): Promise<LabData | null> {
  try {
    const d = JSON.parse(await readFile(file, "utf8")) as LabData;
    return d?.version === 1 && Array.isArray(d.markets) ? d : null;
  } catch {
    return null;
  }
}

export async function saveLab(file: string, data: LabData): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(data));
  await rename(tmp, file);
}

interface RawMarket {
  ticker: string;
  event_ticker?: string;
  result?: string;
  title?: string;
  yes_sub_title?: string;
  expected_expiration_time?: string;
  latest_expiration_time?: string;
  close_time?: string;
}
interface RawCandles {
  market_ticker?: string;
  ticker?: string;
  candlesticks?: Array<{ end_period_ts?: number; yes_bid?: { close_dollars?: string | number }; yes_ask?: { close_dollars?: string | number } }>;
}

export interface LabProgress {
  stage: "games" | "prices";
  done: number;
  total: number;
  note?: string;
}

export interface DownloadOptions {
  /** How far back to keep games. */
  days?: number;
  /** What's already on disk: only newer games are fetched. */
  existing?: LabData | null;
  now?: Date;
  onProgress?: (p: LabProgress) => void;
  /** Test hook. */
  get?: <T>(url: URL) => Promise<T | undefined>;
  pauseMs?: number;
  series?: readonly string[];
  baseUrl?: string;
}

const H = 3600_000;
const HOURS_BACK = 26;

/** Hourly candles → flat (hours before start, bid, ask) triples; hours with no real two-sided quote are skipped. */
export function pathFromCandles(candles: NonNullable<RawCandles["candlesticks"]>, startMs: number): number[] {
  const rows: Array<[number, number, number]> = [];
  for (const c of candles) {
    const end = (c.end_period_ts ?? 0) * 1000;
    if (!end || end > startMs || end < startMs - HOURS_BACK * H) continue;
    const bid = Number(c.yes_bid?.close_dollars);
    const ask = Number(c.yes_ask?.close_dollars);
    if (!(bid > 0) || !(ask < 1) || !(ask >= bid)) continue;
    rows.push([Math.round((startMs - end) / H), Math.round(bid * 1000), Math.round(ask * 1000)]);
  }
  // One quote per hour (the latest), nearest the start last.
  const byHour = new Map(rows.map((r) => [r[0], r]));
  return [...byHour.values()].sort((a, b) => b[0] - a[0]).flat();
}

/**
 * Download settled games (newest first, back to `days` ago) and their pre-game hourly quotes.
 * With `existing`, only games that aren't on disk yet are fetched, so an update takes seconds.
 */
export async function downloadLab(opts: DownloadOptions = {}): Promise<LabData> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 90;
  const cutoff = now.getTime() - days * 24 * H;
  const base = opts.baseUrl ?? process.env.KALSHI_API_BASE?.replace(/\/$/, "") ?? "https://api.elections.kalshi.com/trade-api/v2";
  const pause = () => new Promise((r) => setTimeout(r, opts.pauseMs ?? 300));
  const get = opts.get ?? (async <T>(url: URL) => (await getJson<T>(url, "Kalshi", { retries: 6 })).data);
  const have = new Map((opts.existing?.markets ?? []).filter((m) => m.st >= cutoff).map((m) => [m.t, m]));
  const series = opts.series ?? KALSHI_GAME_SERIES;
  const fresh: LabMarket[] = [];

  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    opts.onProgress?.({ stage: "games", done: i, total: series.length, note: LEAGUE_LABEL[s] ?? s });
    let cursor: string | undefined;
    for (let page = 0; page < 40; page++) {
      const url = new URL(`${base}/markets`);
      url.searchParams.set("series_ticker", s);
      url.searchParams.set("status", "settled");
      url.searchParams.set("limit", "1000");
      if (cursor) url.searchParams.set("cursor", cursor);
      const data = (await get<{ markets?: RawMarket[]; cursor?: string }>(url)) ?? {};
      const rows = data.markets ?? [];
      let stale = 0;
      for (const m of rows) {
        const start = Date.parse(kalshiTimes(m).startsAt ?? "");
        if (!Number.isFinite(start) || (m.result !== "yes" && m.result !== "no")) continue;
        // Older than the window, or already on disk: a whole page of these ends this league.
        if (start < cutoff || have.has(m.ticker)) {
          stale++;
          continue;
        }
        fresh.push({ t: m.ticker, e: m.event_ticker ?? m.ticker, s, n: m.yes_sub_title ?? "", q: m.title ?? "", r: m.result === "yes" ? 1 : 0, st: start, p: [] });
      }
      cursor = data.cursor;
      if (!cursor || !rows.length || stale === rows.length) break;
      await pause();
    }
    await pause();
  }

  fresh.sort((a, b) => a.st - b.st);
  for (let i = 0; i < fresh.length; i += 40) {
    opts.onProgress?.({ stage: "prices", done: i, total: fresh.length });
    const chunk = fresh.slice(i, i + 40);
    const url = new URL(`${base}/markets/candlesticks`);
    url.searchParams.set("market_tickers", chunk.map((m) => m.t).join(","));
    url.searchParams.set("start_ts", String(Math.floor(Math.min(...chunk.map((m) => m.st)) / 1000) - HOURS_BACK * 3600));
    url.searchParams.set("end_ts", String(Math.floor(Math.max(...chunk.map((m) => m.st)) / 1000) + 3600));
    url.searchParams.set("period_interval", "60");
    let data: { markets?: RawCandles[] } | undefined;
    try {
      data = await get<{ markets?: RawCandles[] }>(url);
    } catch {
      data = undefined; // these games simply have no prices this time; the next update retries them
    }
    const by = new Map((data?.markets ?? []).map((c) => [c.market_ticker ?? c.ticker ?? "", c.candlesticks ?? []]));
    for (const m of chunk) m.p = pathFromCandles(by.get(m.t) ?? [], m.st);
    await pause();
  }
  opts.onProgress?.({ stage: "prices", done: fresh.length, total: fresh.length });

  // Games whose prices couldn't be read aren't saved, so the next update asks again.
  const markets = [...have.values(), ...fresh.filter((m) => m.p.length)].sort((a, b) => a.st - b.st);
  return { version: 1, fetchedAt: now.toISOString(), markets };
}

export interface LabSummary {
  markets: number;
  games: number;
  from?: string;
  to?: string;
  fetchedAt?: string;
  leagues: Array<{ series: string; label: string; games: number }>;
}

export function summarizeLab(d: LabData | null): LabSummary {
  if (!d?.markets.length) return { markets: 0, games: 0, leagues: [] };
  const games = new Map<string, string>();
  for (const m of d.markets) games.set(m.e, m.s);
  const per = new Map<string, number>();
  for (const s of games.values()) per.set(s, (per.get(s) ?? 0) + 1);
  return {
    markets: d.markets.length,
    games: games.size,
    from: new Date(d.markets[0].st).toISOString(),
    to: new Date(d.markets[d.markets.length - 1].st).toISOString(),
    fetchedAt: d.fetchedAt,
    leagues: [...per].map(([series, n]) => ({ series, label: LEAGUE_LABEL[series] ?? series, games: n })).sort((a, b) => b.games - a.games),
  };
}
