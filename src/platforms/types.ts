import type { NormalizedMarket, PlatformId } from "../types.js";

export interface ListMarketsOptions {
  /** Soft cap on markets to return after normalization. */
  limit?: number;
  /** Optional keyword hint for adapters that support search. */
  query?: string;
}

/**
 * Read-only market data. Nothing here may place, cancel, or sign orders —
 * any future write path belongs on a separate LiveTradingAdapter that
 * scan / watch / paper never import.
 */
export interface PlatformAdapter {
  readonly id: PlatformId;
  /** Fetch open markets from public endpoints (no API keys). */
  listMarkets(opts?: ListMarketsOptions): Promise<NormalizedMarket[]>;
  /**
   * Fetch one market by id from public endpoints, including closed /
   * resolved ones (sets `status` and `resolvedOutcome`). Used by paper mode
   * to mark and settle positions that fall out of the listing.
   * Returns null when the platform says the market does not exist.
   */
  getMarket?(id: string): Promise<NormalizedMarket | null>;
  /**
   * Approximate taker fee in USD for a fill of `contracts` at `price`
   * (0–1). Used only for paper PnL; omit for fee-free platforms.
   */
  estimateTakerFeeUsd?(contracts: number, price: number): number;
  /**
   * Round a paper order size to what the platform can actually trade
   * (e.g. whole contracts). Omit when fractional sizes are allowed.
   */
  roundContracts?(contracts: number): number;
}
