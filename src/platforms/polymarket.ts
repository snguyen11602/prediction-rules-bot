import type { NormalizedMarket } from "../types.js";
import type { ListMarketsOptions, PlatformAdapter } from "./types.js";

/**
 * Polymarket public reads (no wallet / API key).
 * Gamma (discovery): https://gamma-api.polymarket.com
 * CLOB reads (books/prices): https://clob.polymarket.com — not required for listing.
 *
 * Live trading later needs L1 wallet signing + L2 HMAC API credentials.
 * Docs: https://docs.polymarket.com/getting-started/api
 */
const DEFAULT_GAMMA =
  process.env.POLYMARKET_GAMMA_BASE?.replace(/\/$/, "") ??
  "https://gamma-api.polymarket.com";

interface GammaMarket {
  id?: string;
  question?: string;
  slug?: string;
  outcomePrices?: string; // JSON string e.g. '["0.4","0.6"]'
  outcomes?: string;
  liquidityNum?: number;
  liquidity?: string;
  volume24hr?: number;
  volumeNum?: number;
  endDate?: string;
  endDateIso?: string;
  active?: boolean;
  closed?: boolean;
  clobTokenIds?: string;
}

function parseJsonArray(s?: string): string[] {
  if (!s) return [];
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

export class PolymarketAdapter implements PlatformAdapter {
  readonly id = "polymarket" as const;
  constructor(private readonly gammaBase = DEFAULT_GAMMA) {}

  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    const limit = opts.limit ?? 100;
    const pageSize = Math.min(100, limit);
    const out: NormalizedMarket[] = [];
    let offset = 0;

    while (out.length < limit) {
      const url = new URL(`${this.gammaBase}/markets`);
      url.searchParams.set("closed", "false");
      url.searchParams.set("active", "true");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order", "liquidity");
      url.searchParams.set("ascending", "false");

      const res = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "prediction-rules-bot/0.1 (public-read)",
        },
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(
          `Polymarket Gamma HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
        );
      }

      const batch = (await res.json()) as GammaMarket[];
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const m of batch) {
        if (m.closed) continue;
        const prices = parseJsonArray(m.outcomePrices).map(Number);
        const yes = prices[0];
        if (!Number.isFinite(yes)) continue;
        const title = m.question ?? m.slug ?? m.id ?? "unknown";
        if (opts.query) {
          const q = opts.query.toLowerCase();
          if (!title.toLowerCase().includes(q)) continue;
        }
        const liq =
          m.liquidityNum ??
          (m.liquidity != null ? Number(m.liquidity) : undefined);
        out.push({
          platform: "polymarket",
          id: m.id ?? m.slug ?? String(out.length),
          title,
          yesPrice: clamp01(yes),
          noPrice: Number.isFinite(prices[1]) ? clamp01(prices[1]) : clamp01(1 - yes),
          liquidityUsd: Number.isFinite(liq) ? liq : undefined,
          volume24hUsd: m.volume24hr,
          closesAt: m.endDate ?? m.endDateIso,
          url: m.slug
            ? `https://polymarket.com/event/${encodeURIComponent(m.slug)}`
            : undefined,
          raw: m,
        });
        if (out.length >= limit) break;
      }

      offset += batch.length;
      if (batch.length < pageSize) break;
    }

    return out.slice(0, limit);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
