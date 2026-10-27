/** Normalized market snapshot shared across platforms. */
export type PlatformId = "kalshi" | "polymarket";

export interface NormalizedMarket {
  platform: PlatformId;
  id: string;
  title: string;
  /** Yes / long price in 0–1 range (probability-style). */
  yesPrice: number;
  /** No / short price in 0–1 when available. */
  noPrice?: number;
  /** Mid or last trade if bid/ask unavailable. */
  lastPrice?: number;
  /** Approximate liquidity in USD (platform-dependent). */
  liquidityUsd?: number;
  /** 24h volume in USD when available. */
  volume24hUsd?: number;
  /** ISO close / resolve time when known. */
  closesAt?: string;
  /** Free-form tags / categories from the platform. */
  tags?: string[];
  url?: string;
  raw?: unknown;
}

export type ActionMode = "alert" | "paper" | "live";

export type SignalSide = "yes" | "no";

export interface EngineEvent {
  at: string;
  type:
    | "scan_start"
    | "scan_end"
    | "market_match"
    | "entry_signal"
    | "exit_signal"
    | "risk_block"
    | "adapter_error"
    | "paper_fill"
    | "info";
  message: string;
  ruleId?: string;
  market?: Pick<NormalizedMarket, "platform" | "id" | "title" | "yesPrice" | "url">;
  side?: SignalSide;
  sizeUsd?: number;
  data?: Record<string, unknown>;
}

export interface PaperFill {
  id: string;
  at: string;
  ruleId: string;
  platform: PlatformId;
  marketId: string;
  title: string;
  side: SignalSide;
  price: number;
  sizeUsd: number;
  hypothetical: true;
}
