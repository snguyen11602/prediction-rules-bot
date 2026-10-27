import type { NormalizedMarket } from "../types.js";
import type { ListMarketsOptions, PlatformAdapter } from "./types.js";

/**
 * Kalshi public market data (no API key).
 * Production host (as of 2026): https://api.elections.kalshi.com/trade-api/v2
 * Docs: https://docs.kalshi.com/getting_started/quick_start_market_data
 *
 * Private / trading endpoints need API key + RSA signature auth — not used here.
 */
const DEFAULT_BASE =
  process.env.KALSHI_API_BASE?.replace(/\/$/, "") ??
  "https://api.elections.kalshi.com/trade-api/v2";

interface KalshiMarket {
  ticker: string;
  title?: string;
  status?: string;
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

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "prediction-rules-bot/0.1 (public-read)",
        },
      });

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
        const yes = midYes(m);
        if (yes == null) continue;
        const title = m.title ?? m.ticker;
        if (opts.query) {
          const q = opts.query.toLowerCase();
          if (!title.toLowerCase().includes(q) && !m.ticker.toLowerCase().includes(q)) {
            continue;
          }
        }
        const oi = parseDollars(m.open_interest_fp);
        const vol24 = parseDollars(m.volume_24h_fp);
        out.push({
          platform: "kalshi",
          id: m.ticker,
          title,
          yesPrice: clamp01(yes),
          noPrice: clamp01(1 - yes),
          lastPrice: parseDollars(m.last_price_dollars),
          // OI / volume are in contracts (~$1 notional); treat as rough USD proxy
          liquidityUsd: oi,
          volume24hUsd: vol24,
          closesAt: m.close_time,
          tags: m.event_ticker ? [m.event_ticker] : undefined,
          url: `https://kalshi.com/markets/${encodeURIComponent(m.ticker)}`,
          raw: m,
        });
        if (out.length >= limit) break;
      }

      cursor = data.cursor;
      if (!cursor) break;
    }

    return out.slice(0, limit);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
