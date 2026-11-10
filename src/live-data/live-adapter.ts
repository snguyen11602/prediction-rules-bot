import type { EventGroup, ListMarketsOptions, PlatformAdapter } from "../platforms/types.js";
import type { NormalizedMarket, PlatformId } from "../types.js";
import { QuoteBook, withLiveQuote } from "./quotes.js";

/**
 * Wraps a platform adapter for fast mode. Market lists and per-market data come from the
 * normal REST adapter, cached between full checks; bid/ask are replaced with the latest
 * streamed quote when one is fresh. Read-only, like the adapter it wraps.
 */
export interface LiveAdapterOptions {
  /** Re-read listings / market details from REST at most this often. */
  refreshMs: number;
  /** A streamed quote older than this is ignored. */
  maxQuoteAgeMs: number;
  /**
   * Called with the markets the bot is looking at, so the stream can subscribe to them:
   * "listing" replaces the scanned list; "lookup" adds single markets (e.g. ones we hold).
   */
  watch?: (markets: NormalizedMarket[], source: "listing" | "lookup") => void;
  now?: () => number;
}

export class LiveQuoteAdapter implements PlatformAdapter {
  readonly id: PlatformId;
  private listing?: { at: number; limit: number; query?: string; leagues: string; markets: NormalizedMarket[] };
  private readonly byId = new Map<string, { at: number; market: NormalizedMarket | null }>();
  /** Anything cached before this time is re-read (set by refresh()). */
  private minAt = 0;

  constructor(
    readonly inner: PlatformAdapter,
    private readonly quotes: QuoteBook,
    private readonly opts: LiveAdapterOptions,
  ) {
    this.id = inner.id;
    if (inner.listEventGroups) this.listEventGroups = (o) => inner.listEventGroups!(o);
    if (inner.listEventGroupsPage) this.listEventGroupsPage = (o) => inner.listEventGroupsPage!(o);
    if (inner.priceHistory) this.priceHistory = (ids, since, until) => inner.priceHistory!(ids, since, until);
    if (inner.estimateTakerFeeUsd) this.estimateTakerFeeUsd = (c, p, m) => inner.estimateTakerFeeUsd!(c, p, m);
    if (inner.roundContracts) this.roundContracts = (c, m) => inner.roundContracts!(c, m);
  }

  listEventGroups?: (opts?: { limit?: number }) => Promise<EventGroup[]>;
  listEventGroupsPage?: (opts: { limit?: number; cursor?: string }) => Promise<{ groups: EventGroup[]; cursor?: string }>;
  priceHistory?: PlatformAdapter["priceHistory"];
  estimateTakerFeeUsd?: (contracts: number, price: number, market?: NormalizedMarket) => number;
  roundContracts?: (contracts: number, market?: NormalizedMarket) => number;

  private now(): number {
    return this.opts.now?.() ?? Date.now();
  }

  /** The next call reads fresh REST data (full checks call this). */
  refresh(): void {
    this.minAt = this.now();
  }

  private stale(at: number): boolean {
    return at < this.minAt || this.now() - at > this.opts.refreshMs;
  }

  private live(m: NormalizedMarket): NormalizedMarket {
    return withLiveQuote(m, this.quotes.get(m.platform, m.id), this.opts.maxQuoteAgeMs, this.now());
  }

  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    const limit = opts.limit ?? 100;
    const leagues = [...(opts.leagues ?? [])].sort().join(",");
    const l = this.listing;
    // Markets past a listing's own limit are league games that were asked for by name
    // (`ListMarketsOptions.leagues`): they stay in, whatever this call's limit.
    const cut = (x: NonNullable<typeof l>) => [...x.markets.slice(0, limit), ...x.markets.slice(Math.max(limit, x.limit))].map((m) => this.live(m));
    if (!l || this.stale(l.at) || l.limit < limit || l.query !== opts.query || l.leagues !== leagues) {
      let markets: NormalizedMarket[];
      try {
        markets = await this.inner.listMarkets(opts);
      } catch (err) {
        // Keep the last listing rather than hitting REST again on every quick check.
        if (!l || l.query !== opts.query) throw err;
        l.at = this.now();
        return cut(l);
      }
      this.listing = { at: this.now(), limit, query: opts.query, leagues, markets };
      for (const m of markets) this.byId.set(m.id, { at: this.listing.at, market: m });
      this.opts.watch?.(markets, "listing");
    }
    return cut(this.listing!);
  }

  async getMarket(id: string): Promise<NormalizedMarket | null> {
    const hit = this.byId.get(id);
    if (hit && !this.stale(hit.at)) return hit.market && this.live(hit.market);
    if (!this.inner.getMarket) return null;
    const market = await this.inner.getMarket(id);
    this.byId.set(id, { at: this.now(), market });
    if (market) this.opts.watch?.([market], "lookup");
    return market && this.live(market);
  }

  async getMarkets(ids: string[]): Promise<NormalizedMarket[]> {
    const out: NormalizedMarket[] = [];
    const missing: string[] = [];
    for (const id of ids) {
      const hit = this.byId.get(id);
      if (hit && !this.stale(hit.at)) {
        if (hit.market) out.push(this.live(hit.market));
      } else missing.push(id);
    }
    if (missing.length) {
      const fetched = this.inner.getMarkets
        ? await this.inner.getMarkets(missing)
        : (await Promise.all(missing.map((id) => this.inner.getMarket?.(id) ?? null))).filter((m): m is NormalizedMarket => !!m);
      for (const m of fetched) {
        this.byId.set(m.id, { at: this.now(), market: m });
        out.push(this.live(m));
      }
      if (fetched.length) this.opts.watch?.(fetched, "lookup");
    }
    return out;
  }
}
