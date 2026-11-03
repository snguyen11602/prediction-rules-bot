import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { getJson } from "../platforms/http.js";
import { normalizeKalshi, type KalshiMarket } from "../platforms/kalshi.js";
import { normalizePolymarketUs, type UsMarket } from "../platforms/polymarket-us.js";
import type { NormalizedMarket, PlatformId } from "../types.js";

/**
 * Price history for backtests, from the exchanges' public APIs (no keys):
 *  - Kalshi: hourly candlesticks with the YES bid and ask (plus volume and open interest).
 *  - Polymarket US: price history of both sides (YES ask = long price, YES bid = 1 − short price).
 * Settled markets come with their result, so backtests settle trades exactly as they did.
 * Responses are cached on disk; finished markets never need fetching twice.
 */

/** [epoch seconds, YES bid | null, YES ask | null, 24h volume | null, open interest | null] */
export type HistPoint = [number, number | null, number | null, number | null, number | null];

export interface HistMarket {
  /** The market as the live adapter would describe it (title, outcomes, fees, close time…). */
  market: NormalizedMarket;
  points: HistPoint[];
  /** Final result when settled during the window. */
  result?: { outcome?: "yes" | "no"; yesPayout?: number; at: string };
}

export interface HistorySet {
  from: string;
  to: string;
  markets: HistMarket[];
}

const KALSHI = process.env.KALSHI_API_BASE?.replace(/\/$/, "") ?? "https://api.elections.kalshi.com/trade-api/v2";
const PMUS = process.env.POLYMARKET_US_BASE?.replace(/\/$/, "") ?? "https://gateway.polymarket.us";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const num = (v: unknown) => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
};
/** Empty book sides come back as 0 / 1. */
const px = (v: unknown) => {
  const n = num(v);
  return n != null && n > 0 && n < 1 ? n : null;
};

/** Drop live-only fields (quotes, the raw API object) so a history file stays small. */
function lean(m: NormalizedMarket, raw?: unknown): NormalizedMarket {
  const { raw: _r, yesBid: _b, yesAsk: _a, lastPrice: _l, liquidityUsd: _q, volume24hUsd: _v, quotedAt: _t, ...rest } = m;
  return raw ? { ...rest, raw } : rest;
}

function sortPoints(pts: HistPoint[]): HistPoint[] {
  const seen = new Set<number>();
  return pts.sort((a, b) => a[0] - b[0]).filter((p) => !seen.has(p[0]) && !!seen.add(p[0]));
}

/** Finished markets are cached for good (pruned after CACHE_DAYS); open ones only for this run. */
const CACHE_DAYS = 45;
/** How far back a finished market's history is fetched (enough for any backtest window). */
const HISTORY_DAYS = 60;

async function prepareCache(cacheDir: string): Promise<void> {
  await rm(path.join(cacheDir, "open"), { recursive: true, force: true });
  const cutoff = Date.now() - CACHE_DAYS * 86_400_000;
  for (const sub of ["kalshi", "polymarket_us"]) {
    const dir = path.join(cacheDir, sub);
    const names = await readdir(dir).catch(() => [] as string[]);
    for (const n of names) {
      const f = path.join(dir, n);
      const st = await stat(f).catch(() => null);
      if (st && st.mtimeMs < cutoff) await rm(f, { force: true });
    }
  }
}

/** Keep the points inside the backtest window. */
function inside(pts: HistPoint[], fromS: number, toS: number): HistPoint[] {
  return pts.filter((p) => p[0] >= fromS && p[0] <= toS);
}

async function cached<T>(dir: string, key: string, fresh: boolean, load: () => Promise<T>): Promise<T> {
  const file = path.join(dir, `${key.replace(/[^A-Za-z0-9._-]+/g, "_")}.json`);
  if (!fresh) {
    try {
      return JSON.parse(await readFile(file, "utf8")) as T;
    } catch {
      // not cached yet
    }
  }
  const v = await load();
  await mkdir(dir, { recursive: true });
  await writeFile(file, JSON.stringify(v));
  return v;
}

export interface HistoryOptions {
  from: Date;
  to: Date;
  /** Markets per platform. */
  perPlatform: number;
  platforms: PlatformId[];
  cacheDir: string;
  log?: (m: string) => void;
  /** Pause between Kalshi requests (it rate-limits). Default 400 ms. */
  pauseMs?: number;
}

// ---------------------------------------------------------------- Kalshi

async function kalshiMarkets(status: "settled" | "open", from: Date, pages: number, series?: string, pauseMs = 400): Promise<KalshiMarket[]> {
  const out: KalshiMarket[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < pages; i++) {
    const url = new URL(`${KALSHI}/markets`);
    url.searchParams.set("status", status);
    url.searchParams.set("limit", "1000");
    url.searchParams.set("mve_filter", "exclude");
    if (series) url.searchParams.set("series_ticker", series);
    if (status === "settled") url.searchParams.set("min_close_ts", String(Math.floor(from.getTime() / 1000)));
    if (cursor) url.searchParams.set("cursor", cursor);
    const d = (await getJson<{ markets?: KalshiMarket[]; cursor?: string }>(url, "Kalshi")).data ?? {};
    out.push(...(d.markets ?? []));
    cursor = d.cursor || undefined;
    if (!cursor) break;
    await sleep(pauseMs);
  }
  return out;
}

/**
 * Game markets: they trade for days, many settle inside the window, and they move. (Kalshi also
 * settles thousands of 15-minute crypto markets, but those barely have a history.)
 */
const KALSHI_SERIES = [
  "KXNFLGAME", "KXNCAAFGAME", "KXNBAGAME", "KXNHLGAME", "KXMLBGAME", "KXEPLGAME",
  "KXUCLGAME", "KXLALIGAGAME", "KXNCAAMBGAME", "KXWNBAGAME", "KXMLSGAME",
];

/** Take from each group in turn (busiest first within a group) so one league doesn't fill the set. */
function roundRobin<T>(groups: T[][], n: number): T[] {
  const out: T[] = [];
  for (let i = 0; out.length < n && groups.some((g) => i < g.length); i++) {
    for (const g of groups) if (i < g.length && out.length < n) out.push(g[i]);
  }
  return out;
}

interface Candle {
  end_period_ts: number;
  yes_bid?: { close_dollars?: string };
  yes_ask?: { close_dollars?: string };
  volume_fp?: string;
  open_interest_fp?: string;
}

async function kalshiHistory(o: HistoryOptions): Promise<HistMarket[]> {
  const pause = o.pauseMs ?? 400;
  const fromMs = o.from.getTime();
  const toMs = o.to.getTime();
  /** Hours of trading inside the backtest window. */
  const inWindow = (m: KalshiMarket) =>
    (Math.min(toMs, Date.parse(m.close_time ?? "") || toMs) - Math.max(fromMs, Date.parse(m.open_time ?? "") || fromMs)) / 3600_000;
  const vol = (m: KalshiMarket) => num(m.volume_fp) ?? 0;
  const vol24 = (m: KalshiMarket) => num(m.volume_24h_fp) ?? 0;
  const settledGroups: KalshiMarket[][] = [];
  const openGroups: KalshiMarket[][] = [];
  for (const series of KALSHI_SERIES) {
    try {
      const settled = await kalshiMarkets("settled", o.from, 1, series, pause);
      settledGroups.push(settled.filter((m) => (m.result === "yes" || m.result === "no") && inWindow(m) >= 12).sort((a, b) => vol(b) - vol(a)));
      await sleep(pause);
      const open = await kalshiMarkets("open", o.from, 1, series, pause);
      openGroups.push(open.filter((m) => inWindow(m) >= 12 && vol24(m) > 0).sort((a, b) => vol24(b) - vol24(a)));
    } catch (err) {
      o.log?.(`  Kalshi ${series}: ${(err as Error).message.slice(0, 80)}`);
    }
    await sleep(pause);
  }
  // Half finished (they settle inside the window, so trades really finish), half still open.
  const pickSettled = roundRobin(settledGroups, Math.ceil(o.perPlatform / 2));
  const pickOpen = roundRobin(openGroups, o.perPlatform - pickSettled.length);
  if (pickSettled.length + pickOpen.length < o.perPlatform) {
    // Not enough games: fill up with the busiest other open markets.
    const have = new Set([...pickSettled, ...pickOpen].map((m) => m.ticker));
    const more = (await kalshiMarkets("open", o.from, 2, undefined, pause)).filter((m) => !have.has(m.ticker) && inWindow(m) >= 12 && vol24(m) > 0);
    pickOpen.push(...more.sort((a, b) => vol24(b) - vol24(a)).slice(0, o.perPlatform - pickSettled.length - pickOpen.length));
  }
  const out: HistMarket[] = [];
  const fromS = Math.floor(o.from.getTime() / 1000);
  const toS = Math.floor(o.to.getTime() / 1000);
  let n = 0;
  for (const m of [...pickSettled, ...pickOpen]) {
    const series = m.event_ticker?.split("-")[0];
    if (!series) continue;
    const closeS = m.close_time ? Math.floor(Date.parse(m.close_time) / 1000) : toS;
    const openS = m.open_time ? Math.floor(Date.parse(m.open_time) / 1000) : fromS;
    const finished = m.result === "yes" || m.result === "no" || m.result === "scalar";
    // Finished: its whole recent life, cached once. Open: just the window, for this run only.
    const start = finished ? Math.max(openS, closeS - HISTORY_DAYS * 86_400) : Math.max(fromS, openS);
    const end = finished ? closeS : toS;
    if (end <= start) continue;
    try {
      const dir = finished ? path.join(o.cacheDir, "kalshi") : path.join(o.cacheDir, "open", "kalshi");
      const candles = await cached(dir, finished ? `${m.ticker}-final` : `${m.ticker}-${end}`, false, async () => {
        const url = new URL(`${KALSHI}/series/${encodeURIComponent(series)}/markets/${encodeURIComponent(m.ticker)}/candlesticks`);
        url.searchParams.set("start_ts", String(start));
        url.searchParams.set("end_ts", String(end));
        url.searchParams.set("period_interval", "60");
        const d = (await getJson<{ candlesticks?: Candle[] }>(url, "Kalshi")).data;
        await sleep(pause); // Kalshi rate-limits; be polite
        return d?.candlesticks ?? [];
      });
      // 24h volume from the hourly candles (contracts, like the live adapter's proxy).
      const all: HistPoint[] = [];
      const hourly = candles.map((c) => num(c.volume_fp) ?? 0);
      candles.forEach((c, i) => {
        const v24 = hourly.slice(Math.max(0, i - 23), i + 1).reduce((a, b) => a + b, 0);
        all.push([c.end_period_ts, px(c.yes_bid?.close_dollars), px(c.yes_ask?.close_dollars), v24, num(c.open_interest_fp)]);
      });
      const pts = inside(sortPoints(all), fromS, toS);
      if (!moved(pts)) continue;
      // While a market is open, Kalshi shows its latest possible expiry as the close time; the
      // real close (when the result came in) is only known afterwards. Rules see the former.
      const shownClose = finished ? m.latest_expiration_time ?? m.expiration_time ?? m.close_time : m.close_time;
      const live = normalizeKalshi({ ...m, close_time: shownClose, status: "active", result: "", last_price_dollars: m.last_price_dollars || "0.5" });
      if (!live) continue;
      const at = m.close_time ?? new Date(closeS * 1000).toISOString();
      const scalar = num(m.settlement_value_dollars) ?? (typeof m.settlement_value === "number" ? m.settlement_value / 100 : null);
      const result: HistMarket["result"] =
        m.result === "yes" || m.result === "no"
          ? { outcome: m.result, at }
          : m.result === "scalar" && scalar != null && scalar >= 0 && scalar <= 1
            ? { yesPayout: scalar, at }
            : undefined;
      out.push({ market: lean(live), points: pts, result });
      if (++n % 20 === 0) o.log?.(`  Kalshi: ${n} markets loaded`);
    } catch (err) {
      o.log?.(`  Kalshi ${m.ticker}: ${(err as Error).message.slice(0, 80)}`);
    }
  }
  return out;
}

// ---------------------------------------------------------------- Polymarket US

async function usMarkets(params: Record<string, string>, pages: number): Promise<UsMarket[]> {
  const out: UsMarket[] = [];
  for (let i = 0; i < pages; i++) {
    const url = new URL(`${PMUS}/v1/markets`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("limit", "500");
    url.searchParams.set("offset", String(i * 500));
    const batch = (await getJson<{ markets?: UsMarket[] }>(url, "Polymarket US")).data?.markets ?? [];
    out.push(...batch);
    if (batch.length < 500) break;
  }
  return out;
}

async function usHistory(o: HistoryOptions): Promise<HistMarket[]> {
  const fromMs = o.from.getTime();
  const toMs = o.to.getTime();
  // No public volume here: use game winners, spreads and totals (the busiest kinds), across leagues.
  const kinds = ["aec", "asc", "tsc"];
  const kind = (slug: string) => kinds.indexOf(slug.split("-")[0]);
  const resolved = (await usMarkets({ closed: "true", endDateMin: o.from.toISOString(), endDateMax: o.to.toISOString() }, 3)).filter(
    (m) =>
      m.status === "MARKET_STATUS_RESOLVED" && !!m.slug && kind(m.slug) >= 0 && !m.hidden &&
      !!m.endDate && Date.parse(m.endDate) - fromMs >= 12 * 3600_000 && Date.parse(m.endDate) <= toMs,
  );
  const byLeague = new Map<string, UsMarket[]>();
  for (const m of resolved.sort((x, y) => kind(x.slug!) - kind(y.slug!) || Date.parse(y.endDate!) - Date.parse(x.endDate!))) {
    const league = m.slug!.split("-")[1] ?? "";
    byLeague.set(league, [...(byLeague.get(league) ?? []), m]);
  }
  // Open markets in the same order the live adapter lists them.
  const open = (await usMarkets({ active: "true", closed: "false", orderBy: "volume", orderDirection: "desc" }, 1)).filter((m) => !m.hidden && !!m.slug);
  const wantResolved = Math.ceil(o.perPlatform / 2);
  const out: HistMarket[] = [];
  // Some candidates never traded (flat price): try extras and keep the first ones that moved.
  const take = async (cands: UsMarket[], want: number) => {
    let got = 0;
    for (const m of cands) {
      if (got >= want) break;
      const h = await usOne(m, o, fromMs, toMs);
      if (!h) continue;
      out.push(h);
      got += 1;
      if (out.length % 20 === 0) o.log?.(`  Polymarket US: ${out.length} markets loaded`);
    }
    return got;
  };
  const got = await take(roundRobin([...byLeague.values()], wantResolved * 3), wantResolved);
  if (got < wantResolved) o.log?.(`  Polymarket US: only ${got} finished markets with a usable history`);
  // A short finished set leaves room for more open ones.
  await take(open, o.perPlatform - out.length);
  return out.slice(0, o.perPlatform);
}

/** Open Polymarket US games show an end date about 14 days (340 h) after the start. */
const US_OPEN_END_AFTER_START_MS = 340 * 3600_000;

async function usOne(m: UsMarket, o: HistoryOptions, fromMs: number, toMs: number): Promise<HistMarket | null> {
  const finished = m.status === "MARKET_STATUS_RESOLVED";
  const endMs = m.endDate ? Date.parse(m.endDate) : toMs;
  // Finished: its whole recent life, cached once. Open: just the window, for this run only.
  const startMs = finished ? endMs - HISTORY_DAYS * 86_400_000 : fromMs;
  const stopMs = finished ? endMs + 3600_000 : toMs;
  try {
    const dir = finished ? path.join(o.cacheDir, "polymarket_us") : path.join(o.cacheDir, "open", "polymarket_us");
    const hist = await cached(dir, finished ? `${m.slug}-final` : `${m.slug}-${Math.floor(toMs / 3600_000)}`, false, async () => {
      const url = new URL(`${PMUS}/v1/price-history`);
      url.searchParams.set("symbol", m.slug!);
      url.searchParams.set("timestamp.startTimestamp", String(Math.floor(startMs / 1000)));
      url.searchParams.set("timestamp.endTimestamp", String(Math.floor(stopMs / 1000)));
      url.searchParams.set("fidelity", "60");
      const d = (await getJson<{ history?: Array<{ timestamp: number; longPrice?: number; shortPrice?: number }> }>(url, "Polymarket US")).data;
      let settlement: number | undefined;
      if (finished) {
        const s = await getJson<{ settlement?: number }>(`${PMUS}/v1/markets/${encodeURIComponent(m.slug!)}/settlement`, "Polymarket US");
        settlement = s.status === 404 ? undefined : num(s.data?.settlement) ?? undefined;
      }
      return { history: d?.history ?? [], settlement };
    });
    const all: HistPoint[] = hist.history
      .filter((h) => Number.isFinite(h.timestamp))
      // A point is stamped with the start of its hour; it's only known once that hour is over.
      .map((h) => [h.timestamp + 3600, h.shortPrice != null ? px(1 - h.shortPrice) : null, px(h.longPrice), null, null]);
    const pts = inside(sortPoints(all), Math.floor(fromMs / 1000), Math.floor(toMs / 1000));
    if (!moved(pts)) return null;
    let result: HistMarket["result"];
    const s = hist.settlement;
    if (finished) {
      // Win, lose or a 50/50 push; anything else isn't a payout we can trust.
      if (s !== 0 && s !== 1 && s !== 0.5) return null;
      result = s === 0.5 ? { yesPayout: 0.5, at: m.endDate! } : { outcome: s === 1 ? "yes" : "no", at: m.endDate! };
    }
    // While a game is open its end date is a placeholder ~14 days after the start; the real end
    // only shows once it's over. Rules see the placeholder, the market settles at the real end.
    const start = m.gameStartTime ? Date.parse(m.gameStartTime) : NaN;
    const shownEnd = finished && Number.isFinite(start) ? new Date(Math.max(endMs, start + US_OPEN_END_AFTER_START_MS)).toISOString() : m.endDate;
    // The replay sets the price at each step; this only fills in title, outcomes, fees and close time.
    const live = normalizePolymarketUs({ ...m, endDate: shownEnd, status: "MARKET_STATUS_OPEN", active: true, closed: false, outcomePrices: m.outcomePrices ?? '["0.5","0.5"]' });
    if (!live) return null;
    return { market: lean(live, { minimumTradeQty: m.minimumTradeQty }), points: pts, result };
  } catch (err) {
    o.log?.(`  Polymarket US ${m.slug}: ${(err as Error).message.slice(0, 80)}`);
    return null;
  }
}

/** At least a few different two-sided prices: a market that never traded teaches nothing. */
function moved(pts: HistPoint[]): boolean {
  const mids = new Set<number>();
  for (const [, b, a] of pts) if (b != null && a != null) mids.add(Math.round(((a + b) / 2) * 1000));
  return mids.size >= 3;
}

export async function loadHistory(o: HistoryOptions): Promise<HistorySet> {
  await prepareCache(o.cacheDir);
  const markets: HistMarket[] = [];
  if (o.platforms.includes("kalshi")) markets.push(...(await kalshiHistory(o)));
  if (o.platforms.includes("polymarket_us")) markets.push(...(await usHistory(o)));
  return { from: o.from.toISOString(), to: o.to.toISOString(), markets };
}
