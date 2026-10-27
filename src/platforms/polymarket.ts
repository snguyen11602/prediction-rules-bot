import type { NormalizedMarket } from "../types.js";
import type { EventGroup, ListMarketsOptions, PlatformAdapter } from "./types.js";
import { getJson } from "./http.js";

/**
 * Polymarket public reads (no wallet / API key).
 * Gamma (discovery): https://gamma-api.polymarket.com
 * CLOB reads (books/prices): https://clob.polymarket.com — not required for listing.
 *
 * Live trading later needs L1 wallet signing + L2 HMAC API credentials.
 * Docs: https://docs.polymarket.com/getting-started/api
 *       https://docs.polymarket.com/market-data/market-details
 *
 * Convention: the first outcome is treated as YES (true for Yes/No markets).
 */
const DEFAULT_GAMMA =
  process.env.POLYMARKET_GAMMA_BASE?.replace(/\/$/, "") ??
  "https://gamma-api.polymarket.com";

/** Used when a market doesn't publish its fee schedule (Polymarket's general category rate). */
const DEFAULT_TAKER_FEE_RATE = 0.05;

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
  /** Best bid / ask / last trade for the first (YES) outcome token. */
  bestBid?: number;
  bestAsk?: number;
  lastTradePrice?: number;
  endDate?: string;
  endDateIso?: string;
  active?: boolean;
  closed?: boolean;
  umaResolutionStatus?: string;
  clobTokenIds?: string;
  /** False when the order book is paused / no longer taking orders. */
  acceptingOrders?: boolean;
  feesEnabled?: boolean;
  feeType?: string;
  /** Taker fee = shares × rate × (p × (1 − p))^exponent. */
  feeSchedule?: { rate?: number; exponent?: number; takerOnly?: boolean };
  /** The catch-all "Other" outcome of a neg-risk event. */
  negRiskOther?: boolean;
  events?: Array<{ id?: string | number }>;
}

interface GammaEvent {
  id?: string | number;
  slug?: string;
  title?: string;
  /** Neg-risk events: outcomes are mutually exclusive (one market per outcome). */
  negRisk?: boolean;
  markets?: GammaMarket[];
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

function finite(n: unknown): number | undefined {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function mapStatus(
  m: GammaMarket,
  yes: number,
): Pick<NormalizedMarket, "status" | "resolvedOutcome" | "settlementYesPrice"> {
  if (!m.closed) {
    // A market that stopped taking orders has stale quotes; treat it as closed until it resolves.
    return m.acceptingOrders === false || m.active === false ? { status: "closed" } : { status: "open" };
  }
  const umaResolved = m.umaResolutionStatus?.toLowerCase() === "resolved";
  // After UMA resolution, outcomePrices are the payout — usually 1/0, but a
  // split (e.g. 50/50) resolution pays fractionally.
  if (umaResolved) {
    if (yes === 1 || yes === 0) return { status: "resolved", resolvedOutcome: yes === 1 ? "yes" : "no" };
    return { status: "resolved", settlementYesPrice: yes };
  }
  // Without the UMA flag, only exact 0/1 prices count; a halted market
  // trading near 0.99 must not be settled early.
  if (yes === 1 || yes === 0) return { status: "resolved", resolvedOutcome: yes === 1 ? "yes" : "no" };
  return { status: "closed" };
}

/** Polymarket reports an empty book side as bid 0 / ask 1 — not tradable prices. */
function quote(n: unknown): number | undefined {
  const v = finite(n);
  return v != null && v > 0 && v < 1 ? v : undefined;
}

/** Per-market taker fee rate from the published schedule (0 for fee-free markets). */
function takerFeeRate(m: GammaMarket): number | undefined {
  if (m.feesEnabled === false || m.feeType === "zero_fees") return 0;
  const r = finite(m.feeSchedule?.rate);
  return r != null && r >= 0 ? r : undefined;
}

/** Polymarket taker fee for `contracts` shares at `price`, rounded to 5 decimals as Polymarket does. */
export function polymarketTakerFeeUsd(contracts: number, price: number, rate = DEFAULT_TAKER_FEE_RATE, exponent = 1): number {
  if (contracts <= 0 || price <= 0 || price >= 1 || rate <= 0) return 0;
  const fee = contracts * rate * Math.pow(price * (1 - price), exponent);
  return Math.round(fee * 1e5) / 1e5;
}

function normalize(m: GammaMarket): NormalizedMarket | null {
  // getMarket() looks markets up by Gamma id, so a market without one can't be tracked.
  if (m.id == null || m.id === "") return null;
  const prices = parseJsonArray(m.outcomePrices).map(Number);
  const yes = prices[0];
  if (!Number.isFinite(yes)) return null;
  const title = m.question ?? m.slug ?? m.id ?? "unknown";
  const liq = m.liquidityNum ?? (m.liquidity != null ? Number(m.liquidity) : undefined);
  const lifecycle = mapStatus(m, yes);
  const outcomes = parseJsonArray(m.outcomes);
  const bid = quote(m.bestBid);
  const ask = quote(m.bestAsk);
  return {
    platform: "polymarket",
    id: String(m.id),
    title,
    yesPrice: clamp01(yes),
    noPrice: Number.isFinite(prices[1]) ? clamp01(prices[1]) : clamp01(1 - yes),
    lastPrice: finite(m.lastTradePrice),
    outcomes: outcomes.length ? outcomes : undefined,
    eventId: m.events?.[0]?.id != null ? String(m.events[0].id) : undefined,
    takerFeeRate: takerFeeRate(m),
    yesBid: lifecycle.status === "open" ? bid : undefined,
    yesAsk: lifecycle.status === "open" ? ask : undefined,
    liquidityUsd: Number.isFinite(liq) ? liq : undefined,
    volume24hUsd: m.volume24hr,
    closesAt: m.endDate ?? m.endDateIso,
    ...lifecycle,
    url: m.slug
      ? `https://polymarket.com/event/${encodeURIComponent(m.slug)}`
      : undefined,
    raw: m,
  };
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

      const batch = (await getJson<GammaMarket[]>(url, "Polymarket Gamma")).data ?? [];
      if (!Array.isArray(batch) || batch.length === 0) break;

      for (const m of batch) {
        if (m.closed) continue;
        const norm = normalize(m);
        if (!norm) continue;
        if (opts.query) {
          const q = opts.query.toLowerCase();
          if (!norm.title.toLowerCase().includes(q)) continue;
        }
        out.push(norm);
        if (out.length >= limit) break;
      }

      offset += batch.length;
      if (batch.length < pageSize) break;
    }

    return out.slice(0, limit);
  }

  async getMarket(id: string): Promise<NormalizedMarket | null> {
    const url = `${this.gammaBase}/markets/${encodeURIComponent(id)}`;
    const { status, data: m } = await getJson<GammaMarket>(url, "Polymarket Gamma");
    if (status === 404 || !m) return null;
    return m && typeof m === "object" ? normalize({ ...m, id: m.id ?? id }) : null;
  }

  /**
   * Open neg-risk events with all their outcome markets (closed ones included, so callers
   * can see an outcome that already resolved). Neg-risk means at most one outcome resolves
   * YES. Never reported as exhaustive: Polymarket's "Other" / placeholder outcomes can change
   * meaning as new names are added, so "one of these must win" isn't guaranteed.
   */
  async listEventGroups(opts: { limit?: number } = {}): Promise<EventGroup[]> {
    const limit = opts.limit ?? 100;
    const pageSize = Math.min(100, limit);
    const out: EventGroup[] = [];
    let offset = 0;
    while (out.length < limit) {
      const url = new URL(`${this.gammaBase}/events`);
      url.searchParams.set("closed", "false");
      url.searchParams.set("active", "true");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("order", "liquidity");
      url.searchParams.set("ascending", "false");
      const batch = (await getJson<GammaEvent[]>(url, "Polymarket Gamma")).data ?? [];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const ev of batch) {
        if (ev.id == null || !ev.negRisk) continue;
        const eventId = String(ev.id);
        const markets = (ev.markets ?? [])
          .map((m) => normalize({ ...m, events: m.events ?? [{ id: eventId }] }))
          .filter((m): m is NormalizedMarket => m != null);
        if (markets.filter((m) => m.status === "open").length < 2) continue;
        out.push({
          platform: "polymarket",
          eventId,
          title: ev.title ?? ev.slug ?? eventId,
          mutuallyExclusive: true,
          exhaustive: false,
          markets,
          url: ev.slug ? `https://polymarket.com/event/${encodeURIComponent(ev.slug)}` : undefined,
        });
        if (out.length >= limit) break;
      }
      offset += batch.length;
      if (batch.length < pageSize) break;
    }
    return out;
  }

  /** Uses the market's published fee schedule; unknown markets assume the general 5% rate. */
  estimateTakerFeeUsd(contracts: number, price: number, market?: NormalizedMarket): number {
    const raw = market?.raw as GammaMarket | undefined;
    return polymarketTakerFeeUsd(contracts, price, market?.takerFeeRate ?? DEFAULT_TAKER_FEE_RATE, finite(raw?.feeSchedule?.exponent) ?? 1);
  }
}

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}
