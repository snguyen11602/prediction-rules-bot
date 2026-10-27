import type { NormalizedMarket, PlatformId } from "../types.js";

export interface ListMarketsOptions {
  /** Soft cap on markets to return after normalization. */
  limit?: number;
  /** Optional keyword hint for adapters that support search. */
  query?: string;
}

export interface PlatformAdapter {
  readonly id: PlatformId;
  /** Fetch open markets from public endpoints (no API keys). */
  listMarkets(opts?: ListMarketsOptions): Promise<NormalizedMarket[]>;
}
