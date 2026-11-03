import { getJson } from "./http.js";

/**
 * Global Polymarket's public Data API (v2): the trader leaderboard, each trader's profile stats,
 * closed positions and trades. Public, no key. Docs: https://docs.polymarket.com (Data API v2).
 *
 * This is the only one of the three exchanges that publishes other traders' accounts, so the
 * copy-trading strategy reads leaders here and copies onto Kalshi / Polymarket US.
 */
const DEFAULT_BASE = process.env.POLYMARKET_DATA_BASE?.replace(/\/$/, "") ?? "https://data-api.polymarket.com";

export interface LeaderboardRow {
  rank: number;
  user_id: string;
  user_name?: string;
  pnl: number;
  volume?: number;
}

export interface UserStats {
  proxy_wallet: string;
  /** Distinct markets traded (lifetime). */
  trades: number;
  biggest_win?: number;
  all_time_pnl?: { realized_pnl?: number } | null;
}

export interface ClosedPosition {
  condition_id?: string;
  title?: string;
  outcome?: string;
  realized_pnl?: number;
  last_event_at?: number;
}

export interface TraderTrade {
  proxy_wallet: string;
  side: "BUY" | "SELL";
  outcome: string;
  outcome_index?: number;
  price: number;
  /** Shares. */
  size: number;
  /** Epoch seconds. */
  timestamp: number;
  title?: string;
  slug?: string;
  condition_id?: string;
  event_slug?: string;
  name?: string;
  pseudonym?: string;
  transaction_hash?: string;
}

interface Envelope<T> {
  data?: T | null;
  pagination?: { next_cursor?: string | null; has_more?: boolean };
}

const WALLET = /^0x[0-9a-fA-F]{40}$/;

export class PolymarketDataClient {
  constructor(private readonly base = DEFAULT_BASE) {}

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<Envelope<T>> {
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
    const { data } = await getJson<Envelope<T>>(url, "Polymarket Data API");
    return data ?? {};
  }

  /** PnL board for a window, best first. */
  async leaderboard(timePeriod: "day" | "week" | "month" | "all", limit: number): Promise<LeaderboardRow[]> {
    const out: LeaderboardRow[] = [];
    let cursor: string | undefined;
    while (out.length < limit) {
      const page = await this.get<LeaderboardRow[]>("/v2/leaderboard", cursor ? { cursor } : { time_period: timePeriod, sort_by: "PNL", limit: Math.min(50, limit) });
      out.push(...(page.data ?? []));
      cursor = page.pagination?.next_cursor ?? undefined;
      if (!cursor || !page.data?.length) break;
    }
    return out.filter((r) => WALLET.test(r.user_id)).slice(0, limit);
  }

  async userStats(wallet: string): Promise<UserStats | null> {
    if (!WALLET.test(wallet)) return null;
    return (await this.get<UserStats>("/v2/user-stats", { user: wallet })).data ?? null;
  }

  /** Most recent closed positions (realized results), up to `max`. */
  async closedPositions(wallet: string, max = 200): Promise<ClosedPosition[]> {
    if (!WALLET.test(wallet)) return [];
    const out: ClosedPosition[] = [];
    let cursor: string | undefined;
    while (out.length < max) {
      const page = await this.get<ClosedPosition[]>(
        "/v2/positions",
        cursor ? { user: wallet, cursor } : { user: wallet, status: "CLOSED", sort_by: "TIMESTAMP", limit: Math.min(100, max) },
      );
      out.push(...(page.data ?? []));
      cursor = page.pagination?.next_cursor ?? undefined;
      if (!cursor || !page.data?.length) break;
    }
    return out.slice(0, max);
  }

  /** A trader's fills since `sinceSec` (epoch seconds), newest first. */
  async trades(wallet: string, sinceSec: number, limit = 100): Promise<TraderTrade[]> {
    if (!WALLET.test(wallet)) return [];
    const page = await this.get<TraderTrade[]>("/v2/trades", { user: wallet, start: Math.max(1, Math.floor(sinceSec)), limit });
    return (page.data ?? []).filter((t) => t && (t.side === "BUY" || t.side === "SELL") && Number.isFinite(t.price) && Number.isFinite(t.size));
  }
}
