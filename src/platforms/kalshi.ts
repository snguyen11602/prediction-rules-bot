import type { NormalizedMarket } from "../types.js";
import type { ListMarketsOptions, PlatformAdapter } from "./types.js";

/**
 * Kalshi public market data (no API key).
 * Production host (as of 2026): https://api.elections.kalshi.com/trade-api/v2
 * Docs: https://docs.kalshi.com/getting_started/quick_start_market_data
 *       https://docs.kalshi.com/getting_started/market_lifecycle
 *
 * Private / trading endpoints need API key + RSA signature auth — not used here.
 */
const DEFAULT_BASE =
  process.env.KALSHI_API_BASE?.replace(/\/$/, "") ??
  "https://api.elections.kalshi.com/trade-api/v2";

const HEADERS = {
  Accept: "application/json",
  "User-Agent": "prediction-rules-bot/0.1 (public-read)",
};

interface KalshiMarket {
  ticker: string;
  title?: string;
  /** initialized | active | inactive | closed | determined | disputed | amended | finalized */
  status?: string;
  /** "yes" | "no" | "scalar" | "" once determined. */
  result?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_24h_fp?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  close_time?: string;
  event_ticker?: string;
}

interface KalshiMarketsResponse {
  markets?: KalshiMarket[];
  cursor?: string;
}

function parseDollars(v?: string): number | undefined {
  if (v == null || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function midYes(m: KalshiMarket): number | undefined {
  const bid = parseDollars(m.yes_bid_dollars);
  const ask = parseDollars(m.yes_ask_dollars);
  const last = parseDollars(m.last_price_dollars);
  if (bid != null && ask != null && ask > 0) return (bid + ask) / 2;
  if (last != null && last > 0) return last;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return undefined;
}

function mapStatus(m: KalshiMarket): Pick<NormalizedMarket, "status" | "resolvedOutcome"> {
  const result = m.result?.toLowerCase();
  if (result === "yes" || result === "no") {
    return { status: "resolved", resolvedOutcome: result };
  }
  if (!m.status || m.status === "active") return { status: "open" };
  // Scalar results and pre-settlement states stay "closed" (outcome unknown).
  return { status: "closed" };
}

function normalize(m: KalshiMarket): NormalizedMarket | null {
  const lifecycle = mapStatus(m);
  let yes = midYes(m);
  if (lifecycle.status === "resolved") {
    yes = lifecycle.resolvedOutcome === "yes" ? 1 : 0;
  }
  if (yes == null) return null;
  const bid = parseDollars(m.yes_bid_dollars);
  const ask = parseDollars(m.yes_ask_dollars);
  const oi = parseDollars(m.open_interest_fp);
  const vol24 = parseDollars(m.volume_24h_fp);
  return {
    platform: "kalshi",
    id: m.ticker,
    title: m.title ?? m.ticker,
    yesPrice: clamp01(yes),
    noPrice: clamp01(1 - yes),
    lastPrice: parseDollars(m.last_price_dollars),
    yesBid: bid != null ? clamp01(bid) : undefined,
    yesAsk: ask != null && ask > 0 ? clamp01(ask) : undefined,
    // OI / volume are in contracts (~$1 notional); treat as rough USD proxy
    liquidityUsd: oi,
    volume24hUsd: vol24,
    closesAt: m.close_time,
    ...lifecycle,
    tags: m.event_ticker ? [m.event_ticker] : undefined,
    url: `https://kalshi.com/markets/${encodeURIComponent(m.ticker)}`,
    raw: m,
  };
}

/**
 * Approximate Kalshi general taker fee: ceil(0.07 × C × P × (1 − P)) to the cent.
 * Some series use a different multiplier and makers may pay differently;
 * check Kalshi's current fee schedule before trusting paper PnL to the cent.
 */
export function kalshiTakerFeeUsd(contracts: number, price: number): number {
  if (contracts <= 0 || price <= 0 || price >= 1) return 0;
  const raw = 0.07 * contracts * price * (1 - price);
  return Math.ceil(raw * 100 - 1e-9) / 100;
}

export class KalshiAdapter implements PlatformAdapter {
  readonly id = "kalshi" as const;
  constructor(private readonly baseUrl = DEFAULT_BASE) {}

  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    const limit = opts.limit ?? 100;
    const pageSize = Math.min(200, Math.max(limit, 50));
    const out: NormalizedMarket[] = [];
    let cursor: string | undefined;

    while (out.length < limit) {
      const url = new URL(`${this.baseUrl}/markets`);
      url.searchParams.set("status", "open");
      url.searchParams.set("limit", String(pageSize));
      // Prefer simple binary markets over multivariate combos when supported
      url.searchParams.set("mve_filter", "exclude");
      if (cursor) url.searchParams.set("cursor", cursor);

      const res = await fetch(url, { headers: HEADERS });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Kalshi HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        );
      }

      const data = (await res.json()) as KalshiMarketsResponse;
      const batch = data.markets ?? [];
      if (batch.length === 0) break;

      for (const m of batch) {
        const norm = normalize(m);
        if (!norm) continue;
        if (opts.query) {
          const q = opts.query.toLowerCase();
          if (!norm.title.toLowerCase().includes(q) && !m.ticker.toLowerCase().includes(q)) {
            continue;
          }
        }
        out.push(norm);
        if (out.length >= limit) break;
      }

      cursor = data.cursor;
      if (!cursor) break;
    }

    return out.slice(0, limit);
  }

  async getMarket(id: string): Promise<NormalizedMarket | null> {
    const url = `${this.baseUrl}/markets/${encodeURIComponent(id)}`;
    const res = await fetch(url, { headers: HEADERS });
    if (res.status === 404) return null;
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Kalshi HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    const data = (await res.json()) as { market?: KalshiMarket } & KalshiMarket;
    const m = data.market ?? (data.ticker ? data : undefined);
    return m ? normalize(m) : null;
  }

  estimateTakerFeeUsd(contracts: number, price: number): number {
    return kalshiTakerFeeUsd(contracts, price);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
