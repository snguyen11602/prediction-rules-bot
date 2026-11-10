/** Normalized market snapshot shared across platforms. */
/**
 * kalshi        — Kalshi
 * polymarket    — global Polymarket (polymarket.com); US residents can't open trades there
 * polymarket_us — Polymarket US (polymarket.us), the separate US exchange
 */
export type PlatformId = "kalshi" | "polymarket" | "polymarket_us";

export const PLATFORM_IDS = ["kalshi", "polymarket", "polymarket_us"] as const satisfies readonly PlatformId[];

/** Platforms used when a rule doesn't list any (and for arbitrage unless configured). */
export const DEFAULT_PLATFORMS: PlatformId[] = ["kalshi", "polymarket_us"];

export const PLATFORM_NAMES: Record<PlatformId, string> = {
  kalshi: "Kalshi",
  polymarket: "Polymarket (global)",
  polymarket_us: "Polymarket US",
};

export function platformName(id: string): string {
  return PLATFORM_NAMES[id as PlatformId] ?? id;
}

/** Leagues a game can belong to, as short ids shared by every platform (adapters map their own codes to these). */
export const LEAGUE_IDS = ["nfl", "cfb", "nba", "cbb", "wnba", "nhl", "mlb", "epl", "ucl", "laliga", "mls"] as const;
export type LeagueId = (typeof LEAGUE_IDS)[number];

export const LEAGUE_NAMES: Record<LeagueId, string> = {
  nfl: "NFL",
  cfb: "College football",
  nba: "NBA",
  cbb: "College basketball",
  wnba: "WNBA",
  nhl: "NHL",
  mlb: "MLB",
  epl: "Premier League",
  ucl: "Champions League",
  laliga: "La Liga",
  mls: "MLS",
};

export function leagueName(id: string): string {
  return LEAGUE_NAMES[id as LeagueId] ?? id;
}

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
  /** Best bid for the YES contract (0–1) when the adapter knows it. */
  yesBid?: number;
  /** Best ask for the YES contract (0–1) when the adapter knows it. */
  yesAsk?: number;
  /** Approximate liquidity in USD (platform-dependent). */
  liquidityUsd?: number;
  /** 24h volume in USD when available. */
  volume24hUsd?: number;
  /**
   * The platform doesn't publish 24h volume for this market (Polymarket US). The 24h-volume
   * filter is then skipped and says so, instead of failing every market on that platform.
   */
  volume24hUnavailable?: boolean;
  /**
   * ISO close time as the platform shows it. On Kalshi and Polymarket US sports markets this is a
   * late placeholder (Kalshi: the latest possible expiry, ~2 days after the game); use `resolvesAt`.
   */
  closesAt?: string;
  /** When the result is expected (Kalshi expected expiration; a game's start + 3h). Falls back to closesAt. */
  resolvesAt?: string;
  /** When the event (a game) starts, when the platform says. Bets after this are in-play. */
  startsAt?: string;
  /** "game_winner" for a game's moneyline / match winner, "other" otherwise (spreads, totals, props…). */
  marketType?: "game_winner" | "other";
  /** The league a game market belongs to, when the adapter can tell from the platform's own ids. */
  league?: LeagueId;
  /** When the market was listed (Kalshi). Brand-new markets have empty, jumpy books. */
  createdAt?: string;
  /**
   * Lifecycle as seen by the adapter. Omitted = treat as open.
   * "closed" = trading stopped, outcome not known yet.
   * "resolved" = outcome known (see resolvedOutcome).
   */
  status?: "open" | "closed" | "resolved";
  /** Winning side once status === "resolved" (omitted for split / non-binary payouts). */
  resolvedOutcome?: SignalSide;
  /**
   * YES payout (0–1) once resolved, when it isn't simply 1 or 0
   * (e.g. a 50/50 resolution or a scalar settlement). NO pays 1 − this.
   */
  settlementYesPrice?: number;
  /**
   * The specific outcome when the platform splits it from the question
   * (Kalshi `yes_sub_title`, e.g. "Cut 25bps"). Already appended to `title`.
   */
  subtitle?: string;
  /** Outcome labels in YES/NO order when known (e.g. ["Yes","No"]). */
  outcomes?: string[];
  /** Platform event this market belongs to (Kalshi event_ticker, Polymarket event id). */
  eventId?: string;
  /** Taker fee rate for fee = contracts × rate × p × (1 − p), when the platform publishes it per market. */
  takerFeeRate?: number;
  /** Set when yesBid / yesAsk come from a live WebSocket stream (ISO time of that quote). */
  quotedAt?: string;
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
    | "paper_exit"
    | "paper_summary"
    | "arb_signal"
    | "arb_open"
    | "arb_close"
    | "info";
  message: string;
  ruleId?: string;
  market?: Pick<NormalizedMarket, "platform" | "id" | "title" | "yesPrice" | "url">;
  side?: SignalSide;
  sizeUsd?: number;
  data?: Record<string, unknown>;
}

export type PaperExitReason =
  | "take_profit"
  | "stop_loss"
  | "time_to_resolve"
  | "max_hold"
  | "resolved"
  | "manual"
  | "arb_unwind"
  | "trailing_stop"
  /** Copy trading: the trader we copied sold the bet. */
  | "leader_sold";

/**
 * Append-only journal row in the paper ledger. v1 ledgers only had opening
 * fills; `kind` and the PnL fields are optional so those rows still parse.
 */
export interface PaperFill {
  id: string;
  at: string;
  ruleId: string;
  platform: PlatformId;
  marketId: string;
  title: string;
  side: SignalSide;
  /** Price paid / received for the held side (0–1). */
  price: number;
  /** Cost basis (open) or proceeds (close) in USD, before fees. */
  sizeUsd: number;
  hypothetical: true;
  kind?: "open" | "close";
  positionId?: string;
  contracts?: number;
  feeUsd?: number;
  /** Realized PnL for this position, on close rows only. */
  pnlUsd?: number;
  reason?: PaperExitReason;
}
