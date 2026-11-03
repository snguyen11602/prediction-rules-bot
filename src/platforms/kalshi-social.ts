import { getJson } from "./http.js";

/**
 * Kalshi's public social API (the leaderboard and trader profiles the Kalshi app shows). Public,
 * no key, read-only. Trades are only listed for traders who made them public
 * (`visibility_state: "visible"`); holdings are always hidden.
 *
 * Units: leaderboard `value` is USD; profile metrics `pnl` / `dollars_traded` are in 1/10,000 USD.
 * A trade's `price_dollars` is the YES price whichever side was taken (a NO taker paid 1 − price).
 */
const DEFAULT_BASE =
  process.env.KALSHI_SOCIAL_BASE?.replace(/\/$/, "") ??
  (process.env.KALSHI_API_BASE?.replace(/\/$/, "").replace(/\/trade-api\/v2$/, "") ?? "https://api.elections.kalshi.com") + "/v1/social";

export type KalshiPeriod = "daily" | "weekly" | "monthly" | "yearly" | "all_time";

export interface KalshiRankRow {
  nickname: string;
  /** Profit over the window, USD. */
  value: number;
  rank: number;
  is_anonymous?: boolean;
}

export interface KalshiMetrics {
  pnlUsd: number;
  markets: number;
  volumeUsd?: number;
}

export interface KalshiSocialTrade {
  trade_id: string;
  ticker: string;
  /** YES price of the trade, whichever side the taker took. */
  price_dollars: string;
  count_fp?: string;
  count?: number;
  taker_side: "yes" | "no";
  taker_action: "buy" | "sell";
  maker_nickname?: string;
  taker_nickname?: string;
  create_date: string;
}

const NICK = /^[A-Za-z0-9._-]{1,64}$/;

/** Space requests out: Kalshi rate-limits per IP, and the paper cycle needs its own Kalshi reads too. */
const MIN_GAP_MS = 120;

export class KalshiSocialClient {
  private next = 0;

  constructor(
    private readonly base = DEFAULT_BASE,
    private readonly gapMs = MIN_GAP_MS,
  ) {}

  private async pace(): Promise<void> {
    const now = Date.now();
    const at = Math.max(now, this.next);
    this.next = at + this.gapMs;
    if (at > now) await new Promise((r) => setTimeout(r, at - now));
  }

  private async get<T>(path: string, params: Record<string, string | number | undefined>): Promise<T | undefined> {
    await this.pace();
    const url = new URL(`${this.base}${path}`);
    for (const [k, v] of Object.entries(params)) if (v != null && v !== "") url.searchParams.set(k, String(v));
    return (await getJson<T>(url, "Kalshi social API")).data;
  }

  /** Profit board for a window, best first. */
  async leaderboard(period: KalshiPeriod, limit: number): Promise<KalshiRankRow[]> {
    const data = await this.get<{ rank_list?: KalshiRankRow[] }>("/leaderboard", { metric_name: "projected_pnl", time_period: period, limit: Math.min(100, limit) });
    return (data?.rank_list ?? []).filter((r) => r && NICK.test(r.nickname) && Number.isFinite(r.value)).slice(0, limit);
  }

  /** Lifetime profit and markets traded (or over `period`). */
  async metrics(nickname: string, period?: KalshiPeriod): Promise<KalshiMetrics | null> {
    if (!NICK.test(nickname)) return null;
    const data = await this.get<{ metrics?: { pnl?: number; num_markets_traded?: number; dollars_traded?: number } }>("/profile/metrics", { nickname, time_period: period });
    const m = data?.metrics;
    if (!m) return null;
    return {
      pnlUsd: (m.pnl ?? 0) / 10_000,
      markets: m.num_markets_traded ?? 0,
      volumeUsd: m.dollars_traded != null ? m.dollars_traded / 10_000 : undefined,
    };
  }

  /** A trader's latest fills, newest first; `visible: false` when they keep trades private. */
  async trades(nickname: string, limit = 100): Promise<{ visible: boolean; trades: KalshiSocialTrade[] }> {
    if (!NICK.test(nickname)) return { visible: false, trades: [] };
    const data = await this.get<{ trades?: KalshiSocialTrade[]; visibility_state?: string }>("/trades", { nickname, limit: Math.min(100, limit) });
    const visible = data?.visibility_state === "visible";
    const trades = (data?.trades ?? []).filter(
      (t) => t && typeof t.ticker === "string" && Number.isFinite(Number(t.price_dollars)) && (t.taker_side === "yes" || t.taker_side === "no") && (t.taker_action === "buy" || t.taker_action === "sell"),
    );
    return { visible, trades: visible ? trades : [] };
  }
}
