import type { NormalizedMarket } from "../types.js";
import type { ListMarketsOptions, PlatformAdapter } from "./types.js";
import { getJson } from "./http.js";

/**
 * Polymarket US (the CFTC-regulated US exchange) — public reads only, no API key.
 * Public gateway: https://gateway.polymarket.us   (docs: https://docs.polymarket.us)
 *
 * Polymarket US is a separate exchange from global Polymarket (polymarket.com): different
 * markets, prices and accounts. US residents can only open trades here.
 *
 * Each market is one binary contract. Its "long" side is YES; bestBidQuote / bestAskQuote
 * are quotes for the long side, and the short side trades at 1 − those.
 *
 * What the public API does NOT give (as of Nov 2026), and how we fill the gaps:
 *  - Liquidity: computed from the order book for the first markets in the listing
 *    (resting orders within 10¢ of the mid, valued at their price).
 *  - 24h volume: not published. If the book shows no trade in the last 24h we report 0;
 *    otherwise the market is flagged `volume24hUnavailable` so the 24h-volume filter is
 *    skipped (spread and liquidity still apply) instead of failing every market.
 *  - Mutually exclusive events: no public flag, so no same-site arbitrage here
 *    (we never guess that from titles).
 */
const DEFAULT_BASE =
  process.env.POLYMARKET_US_BASE?.replace(/\/$/, "") ?? "https://gateway.polymarket.us";

/** Θ in fee = Θ × C × p × (1 − p) when a market doesn't publish feeCoefficient. */
export const POLYMARKET_US_DEFAULT_FEE = 0.0695;

/** Markets per listing whose order book we read for liquidity (each is one request). */
const DEFAULT_ENRICH = Number(process.env.POLYMARKET_US_BOOKS ?? 100);
/** 4 workers with a short pause each stay well under the 25 requests/s public limit. */
const BOOK_CONCURRENCY = 4;
const BOOK_PAUSE_MS = 150;
const LIQUIDITY_BAND = 0.1;
const DAY_MS = 86_400_000;

interface Amount {
  value?: string;
  currency?: string;
}

interface UsMarketSide {
  description?: string;
  long?: boolean;
  price?: string;
  tradable?: boolean;
}

export interface UsMarket {
  id?: string | number;
  slug?: string;
  question?: string;
  title?: string | null;
  subtitle?: string | null;
  description?: string;
  category?: string;
  endDate?: string;
  active?: boolean;
  closed?: boolean;
  hidden?: boolean;
  status?: string;
  marketSides?: UsMarketSide[];
  outcomePrices?: string;
  bestBidQuote?: Amount | null;
  bestAskQuote?: Amount | null;
  feeCoefficient?: number;
  minimumTradeQty?: number;
  sportsMarketType?: string;
  gameStartTime?: string;
  tags?: Array<{ slug?: string; label?: string }>;
}

interface BookLevel {
  px?: Amount;
  qty?: string;
}

interface UsBook {
  bids?: BookLevel[];
  offers?: BookLevel[];
  state?: string;
  stats?: {
    lastTradePx?: Amount;
    lastTradeSetTime?: string;
  };
}

function finite(n: unknown): number | undefined {
  const v = typeof n === "string" ? Number(n) : n;
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/** An empty side, or 0 / 1, is not a price you can trade at. */
function quote(a: Amount | null | undefined): number | undefined {
  const v = finite(a?.value);
  return v != null && v > 0 && v < 1 ? v : undefined;
}

/** Fee = Θ × C × p × (1 − p), banker's-rounded to the cent (Polymarket US fee schedule). */
export function polymarketUsTakerFeeUsd(contracts: number, price: number, theta = POLYMARKET_US_DEFAULT_FEE): number {
  if (contracts <= 0 || price <= 0 || price >= 1 || theta <= 0) return 0;
  return bankersRound2(theta * contracts * price * (1 - price));
}

export function bankersRound2(x: number): number {
  const scaled = x * 100;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  const eps = 1e-9;
  let r: number;
  if (diff > 0.5 + eps) r = floor + 1;
  else if (diff < 0.5 - eps) r = floor;
  else r = floor % 2 === 0 ? floor : floor + 1;
  return r / 100;
}

function firstOutcomePrice(s?: string): number | undefined {
  try {
    const v = JSON.parse(s ?? "[]");
    return Array.isArray(v) ? finite(v[0]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * "Question — Outcome" (the same shape as Kalshi titles). Many markets share one question
 * ("Which company will have the #1 AI model in 2026?"), so the outcome must be in the title
 * or different markets would look identical to the pair matcher.
 */
function titleOf(m: UsMarket, longSide?: string): { title: string; subtitle?: string } {
  const q = (m.question ?? "").trim();
  const t = (m.title ?? "").trim();
  const base = q || t || m.slug || String(m.id ?? "unknown");
  let title = base;
  let subtitle: string | undefined;
  if (t && q && !q.toLowerCase().includes(t.toLowerCase())) {
    title = `${q} — ${t}`;
    subtitle = t;
  }
  // Two-sided markets like "Seoul vs Daegu" or "Over / Under": say which side is YES.
  if (longSide && !/^yes$/i.test(longSide) && !title.toLowerCase().includes(`yes = ${longSide.toLowerCase()}`)) {
    title = `${title} [YES = ${longSide}]`;
  }
  return { title, subtitle };
}

type Lifecycle = Pick<NormalizedMarket, "status" | "resolvedOutcome" | "settlementYesPrice">;

function lifecycleOf(m: UsMarket): Lifecycle {
  const s = m.status ?? "";
  if (s === "MARKET_STATUS_OPEN" && m.active !== false && m.closed !== true) return { status: "open" };
  // RESOLVED is settled from the settlement endpoint (see getMarket); until then it's closed.
  return { status: "closed" };
}

export function normalizePolymarketUs(m: UsMarket, settlement?: number): NormalizedMarket | null {
  if (m.id == null || m.id === "" || !m.slug) return null;
  const sides = m.marketSides ?? [];
  const long = sides.find((s) => s.long === true);
  const short = sides.find((s) => s.long === false);
  const lifecycle = lifecycleOf(m);
  const bid = lifecycle.status === "open" ? quote(m.bestBidQuote) : undefined;
  const ask = lifecycle.status === "open" ? quote(m.bestAskQuote) : undefined;

  let resolved: Lifecycle | undefined;
  if (m.status === "MARKET_STATUS_RESOLVED" && settlement != null && settlement >= 0 && settlement <= 1) {
    resolved =
      settlement === 1 || settlement === 0
        ? { status: "resolved", resolvedOutcome: settlement === 1 ? "yes" : "no" }
        : { status: "resolved", settlementYesPrice: settlement };
  }

  const longPx = finite(long?.price);
  const yes =
    resolved != null
      ? settlement!
      : bid != null && ask != null
        ? (bid + ask) / 2
        : (longPx ?? bid ?? ask ?? firstOutcomePrice(m.outcomePrices));
  if (yes == null || !Number.isFinite(yes)) return null;

  const { title, subtitle } = titleOf(m, long?.description);
  const tags = [m.category, ...(m.tags ?? []).map((t) => t.slug ?? t.label)].filter((t): t is string => !!t);
  return {
    platform: "polymarket_us",
    id: String(m.id),
    title,
    subtitle,
    yesPrice: Math.min(1, Math.max(0, yes)),
    noPrice: Math.min(1, Math.max(0, 1 - yes)),
    yesBid: bid,
    yesAsk: ask,
    outcomes: long?.description && short?.description ? [long.description, short.description] : undefined,
    takerFeeRate: finite(m.feeCoefficient) ?? POLYMARKET_US_DEFAULT_FEE,
    closesAt: m.endDate,
    tags: tags.length ? [...new Set(tags)] : undefined,
    volume24hUnavailable: true,
    ...(resolved ?? lifecycle),
    raw: m,
  };
}

/** Liquidity and last-trade info from the order book. */
export function applyBook(m: NormalizedMarket, book: UsBook | undefined, now: Date): NormalizedMarket {
  if (!book) return m;
  const mid = m.yesBid != null && m.yesAsk != null ? (m.yesBid + m.yesAsk) / 2 : m.yesPrice;
  let depth = 0;
  for (const lvl of [...(book.bids ?? []), ...(book.offers ?? [])]) {
    const px = finite(lvl.px?.value);
    const qty = finite(lvl.qty);
    if (px == null || qty == null || qty <= 0) continue;
    if (Math.abs(px - mid) <= LIQUIDITY_BAND + 1e-9) depth += px * qty;
  }
  const out: NormalizedMarket = { ...m, liquidityUsd: Math.round(depth * 100) / 100 };
  const last = finite(book.stats?.lastTradePx?.value);
  if (last != null) out.lastPrice = last;
  const lastAt = book.stats?.lastTradeSetTime ? Date.parse(book.stats.lastTradeSetTime) : NaN;
  if (Number.isFinite(lastAt) && now.getTime() - lastAt > DAY_MS) {
    // Nothing traded in a day: that is a known 24h volume of zero.
    out.volume24hUsd = 0;
    delete out.volume24hUnavailable;
  }
  return out;
}

async function pool<T, R>(items: T[], n: number, pauseMs: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
        if (pauseMs > 0 && i < items.length) await new Promise((r) => setTimeout(r, pauseMs));
      }
    }),
  );
  return out;
}

export class PolymarketUsAdapter implements PlatformAdapter {
  readonly id = "polymarket_us" as const;

  constructor(
    private readonly base = DEFAULT_BASE,
    private readonly opts: { books?: number; now?: () => Date; pauseMs?: number } = {},
  ) {}

  private now(): Date {
    return this.opts.now?.() ?? new Date();
  }

  private async book(slug: string): Promise<UsBook | undefined> {
    try {
      const { data } = await getJson<{ marketData?: UsBook }>(
        `${this.base}/v1/markets/${encodeURIComponent(slug)}/book`,
        "Polymarket US",
        { retries: 2, timeoutMs: 15_000 },
      );
      return data?.marketData;
    } catch {
      return undefined; // a missing book just means "no liquidity number" for this market
    }
  }

  /** Open markets, most-traded first (server-side order by lifetime volume). */
  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    const limit = opts.limit ?? 100;
    const pageSize = Math.min(500, Math.max(50, limit));
    const out: NormalizedMarket[] = [];
    let offset = 0;
    while (out.length < limit) {
      const url = new URL(`${this.base}/v1/markets`);
      url.searchParams.set("active", "true");
      url.searchParams.set("closed", "false");
      url.searchParams.set("limit", String(pageSize));
      url.searchParams.set("offset", String(offset));
      url.searchParams.set("orderBy", "volume");
      url.searchParams.set("orderDirection", "desc");
      const batch = (await getJson<{ markets?: UsMarket[] }>(url, "Polymarket US")).data?.markets ?? [];
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const raw of batch) {
        if (raw.hidden) continue;
        const m = normalizePolymarketUs(raw);
        if (!m || m.status !== "open") continue;
        if (opts.query && !m.title.toLowerCase().includes(opts.query.toLowerCase())) continue;
        out.push(m);
        if (out.length >= limit) break;
      }
      offset += batch.length;
      if (batch.length < pageSize) break;
    }

    // Rules look at the first markets of each platform, so read books for those.
    const n = Math.min(out.length, this.opts.books ?? DEFAULT_ENRICH);
    const now = this.now();
    const books = await pool(out.slice(0, n), BOOK_CONCURRENCY, this.opts.pauseMs ?? BOOK_PAUSE_MS, (m) => this.book((m.raw as UsMarket).slug!));
    for (let k = 0; k < n; k++) out[k] = applyBook(out[k], books[k], now);
    return out;
  }

  private async settle(m: UsMarket): Promise<NormalizedMarket | null> {
    if (m.status !== "MARKET_STATUS_RESOLVED" || !m.slug) return normalizePolymarketUs(m);
    const { status, data } = await getJson<{ settlement?: number }>(
      `${this.base}/v1/markets/${encodeURIComponent(m.slug)}/settlement`,
      "Polymarket US",
    );
    // No settlement yet → stays "closed" until the exchange publishes it.
    return normalizePolymarketUs(m, status === 404 ? undefined : finite(data?.settlement));
  }

  async getMarket(id: string): Promise<NormalizedMarket | null> {
    if (!/^\d+$/.test(id)) return null;
    const { status, data } = await getJson<{ market?: UsMarket }>(`${this.base}/v1/market/id/${id}`, "Polymarket US");
    if (status === 404 || !data?.market) return null;
    return this.settle(data.market);
  }

  /** Markets by slug (open or not), e.g. a game found from a global Polymarket slug. */
  async getMarketsBySlug(slugs: string[]): Promise<NormalizedMarket[]> {
    const want = [...new Set(slugs.filter(Boolean))];
    const out: NormalizedMarket[] = [];
    for (let i = 0; i < want.length; i += 50) {
      const chunk = want.slice(i, i + 50);
      const url = new URL(`${this.base}/v1/markets`);
      for (const s of chunk) url.searchParams.append("slug", s);
      url.searchParams.set("limit", String(chunk.length));
      const batch = (await getJson<{ markets?: UsMarket[] }>(url, "Polymarket US")).data?.markets ?? [];
      for (const raw of batch) {
        const m = normalizePolymarketUs(raw);
        if (m) out.push(m);
      }
    }
    return out;
  }

  async getMarkets(ids: string[]): Promise<NormalizedMarket[]> {
    const want = [...new Set(ids.filter((id) => /^\d+$/.test(id)))];
    const out: NormalizedMarket[] = [];
    for (let i = 0; i < want.length; i += 100) {
      const chunk = want.slice(i, i + 100);
      const url = new URL(`${this.base}/v1/markets`);
      for (const id of chunk) url.searchParams.append("id", id);
      url.searchParams.set("limit", String(chunk.length));
      const batch = (await getJson<{ markets?: UsMarket[] }>(url, "Polymarket US")).data?.markets ?? [];
      for (const raw of batch) {
        const m = await this.settle(raw);
        if (m) out.push(m);
      }
    }
    return out;
  }

  estimateTakerFeeUsd(contracts: number, price: number, market?: NormalizedMarket): number {
    return polymarketUsTakerFeeUsd(contracts, price, market?.takerFeeRate ?? POLYMARKET_US_DEFAULT_FEE);
  }

  /** Markets trade in steps of `minimumTradeQty` (0.01 or 1 contract). Unknown → whole contracts. */
  roundContracts(contracts: number, market?: NormalizedMarket): number {
    const step = finite((market?.raw as UsMarket | undefined)?.minimumTradeQty);
    const s = step != null && step > 0 && step <= 1 ? step : 1;
    return Math.round(Math.floor(contracts / s + 1e-9) * s * 1e6) / 1e6;
  }
}
