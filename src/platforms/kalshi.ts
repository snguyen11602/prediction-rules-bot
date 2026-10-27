import type { NormalizedMarket } from "../types.js";
import type { EventGroup, ListMarketsOptions, PlatformAdapter } from "./types.js";

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
  /** The specific outcome, e.g. "Cut 25bps" under "Fed decision in December?". */
  yes_sub_title?: string;
  /** initialized | active | inactive | closed | determined | disputed | amended | finalized */
  status?: string;
  /** "yes" | "no" | "scalar" | "" once determined. */
  result?: string;
  /** YES payout for scalar settlements (field name varies by API version). */
  settlement_value_dollars?: string;
  settlement_value?: number;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  volume_24h_fp?: string;
  volume_fp?: string;
  open_interest_fp?: string;
  close_time?: string;
  event_ticker?: string;
}

interface KalshiEvent {
  event_ticker: string;
  title?: string;
  sub_title?: string;
  /** "If true, only one market in this event can resolve to 'yes'." */
  mutually_exclusive?: boolean;
  /** Only populated with with_nested_markets=true. */
  markets?: KalshiMarket[];
}

interface KalshiEventsResponse {
  events?: KalshiEvent[];
  cursor?: string;
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

/**
 * Kalshi reports an empty side of the book as a 0 bid / 1.00 ask.
 * Those are not prices anyone can trade at, so map them to "no quote".
 */
function quotes(m: KalshiMarket): { bid?: number; ask?: number } {
  const bid = parseDollars(m.yes_bid_dollars);
  const ask = parseDollars(m.yes_ask_dollars);
  return {
    bid: bid != null && bid > 0 && bid < 1 ? bid : undefined,
    ask: ask != null && ask > 0 && ask < 1 ? ask : undefined,
  };
}

function midYes(m: KalshiMarket): number | undefined {
  const { bid, ask } = quotes(m);
  const last = parseDollars(m.last_price_dollars);
  if (bid != null && ask != null) return (bid + ask) / 2;
  if (last != null && last > 0) return last;
  if (bid != null) return bid;
  if (ask != null) return ask;
  return undefined;
}

/** Only these states have a final result; disputed / amended results can still change. */
const FINAL_STATES = new Set(["determined", "finalized", "settled"]);

function mapStatus(
  m: KalshiMarket,
): Pick<NormalizedMarket, "status" | "resolvedOutcome" | "settlementYesPrice"> {
  const status = m.status?.toLowerCase();
  const result = m.result?.toLowerCase();
  if (status && FINAL_STATES.has(status)) {
    if (result === "yes" || result === "no") return { status: "resolved", resolvedOutcome: result };
    if (result === "scalar") {
      const v =
        parseDollars(m.settlement_value_dollars) ??
        (typeof m.settlement_value === "number" ? m.settlement_value / 100 : undefined);
      if (v != null && v >= 0 && v <= 1) return { status: "resolved", settlementYesPrice: v };
    }
  }
  if (!status || status === "active") return { status: "open" };
  // Paused, closed, disputed, amended, or final without a usable result.
  return { status: "closed" };
}

function normalize(m: KalshiMarket): NormalizedMarket | null {
  const lifecycle = mapStatus(m);
  let yes = midYes(m);
  if (lifecycle.status === "resolved") {
    yes = lifecycle.settlementYesPrice ?? (lifecycle.resolvedOutcome === "yes" ? 1 : 0);
  }
  if (yes == null) return null;
  const { bid, ask } = lifecycle.status === "open" ? quotes(m) : {};
  const oi = parseDollars(m.open_interest_fp);
  const vol24 = parseDollars(m.volume_24h_fp);
  const base = (m.title ?? m.ticker).trim();
  const sub = m.yes_sub_title?.trim();
  // Many Kalshi markets share an event-level title and differ only in yes_sub_title.
  const informative = !!sub && sub.toLowerCase() !== "yes" && !base.toLowerCase().includes(sub.toLowerCase());
  return {
    platform: "kalshi",
    id: m.ticker,
    title: informative ? `${base} — ${sub}` : base,
    subtitle: informative ? sub : undefined,
    yesPrice: clamp01(yes),
    noPrice: clamp01(1 - yes),
    lastPrice: parseDollars(m.last_price_dollars),
    yesBid: bid,
    yesAsk: ask,
    // OI / volume are in contracts (~$1 notional); treat as rough USD proxy
    liquidityUsd: oi,
    volume24hUsd: vol24,
    closesAt: m.close_time,
    eventId: m.event_ticker,
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

  /** Open events with nested markets. Kalshi says whether outcomes are mutually exclusive, not whether one must win. */
  async listEventGroups(opts: { limit?: number } = {}): Promise<EventGroup[]> {
    const limit = opts.limit ?? 100;
    const out: EventGroup[] = [];
    let cursor: string | undefined;
    while (out.length < limit) {
      const url = new URL(`${this.baseUrl}/events`);
      url.searchParams.set("status", "open");
      url.searchParams.set("with_nested_markets", "true");
      url.searchParams.set("limit", String(Math.min(200, Math.max(limit, 20))));
      if (cursor) url.searchParams.set("cursor", cursor);
      const res = await fetch(url, { headers: HEADERS });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`Kalshi HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as KalshiEventsResponse;
      const batch = data.events ?? [];
      if (batch.length === 0) break;
      for (const ev of batch) {
        const markets = (ev.markets ?? [])
          .map((m) => normalize({ ...m, event_ticker: m.event_ticker ?? ev.event_ticker }))
          .filter((m): m is NormalizedMarket => m != null);
        if (markets.length < 2) continue;
        out.push({
          platform: "kalshi",
          eventId: ev.event_ticker,
          title: ev.title ?? ev.event_ticker,
          mutuallyExclusive: ev.mutually_exclusive === true,
          exhaustive: false,
          markets,
          url: `https://kalshi.com/events/${encodeURIComponent(ev.event_ticker)}`,
        });
        if (out.length >= limit) break;
      }
      cursor = data.cursor;
      if (!cursor) break;
    }
    return out;
  }

  /** Kalshi trades whole contracts. */
  roundContracts(contracts: number): number {
    return Math.floor(contracts + 1e-9);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
