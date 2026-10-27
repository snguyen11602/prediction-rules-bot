import { z } from "zod";

/** Shared rule schema — keep stable; extend with optional fields only. */

export const MarketFiltersSchema = z.object({
  /** Platforms this rule applies to. Empty / omitted = both. */
  platforms: z.array(z.enum(["kalshi", "polymarket"])).optional(),
  /** Title must contain at least one of these (case-insensitive). */
  keywords_any: z.array(z.string()).optional(),
  /** Title must contain all of these. */
  keywords_all: z.array(z.string()).optional(),
  /** Skip if title matches any of these. */
  keywords_exclude: z.array(z.string()).optional(),
  /** Yes-price band (0–1). */
  min_price: z.number().min(0).max(1).optional(),
  max_price: z.number().min(0).max(1).optional(),
  /** Minimum liquidity in USD when the adapter provides it. */
  min_liquidity_usd: z.number().nonnegative().optional(),
  /** Minimum 24h volume in USD. Markets without volume data fail this filter. */
  min_volume_24h_usd: z.number().nonnegative().optional(),
  /**
   * Max YES bid/ask spread (0–1, e.g. 0.03 = 3¢). Markets without bid/ask
   * fail this filter, so paper fills are only taken where quotes are known.
   */
  max_spread: z.number().min(0).max(1).optional(),
  /** Max hours until market close/resolve. */
  max_hours_to_resolve: z.number().positive().optional(),
  min_hours_to_resolve: z.number().nonnegative().optional(),
});

export const EntryConditionsSchema = z.object({
  /**
   * Fire when yes price is within [min_price, max_price] after filters.
   * Optional extra threshold: yes_price crosses above/below a level vs prior scan.
   */
  yes_price_above: z.number().min(0).max(1).optional(),
  yes_price_below: z.number().min(0).max(1).optional(),
  /** Absolute move in yes price since previous observation (0–1). */
  yes_price_move_abs: z.number().min(0).max(1).optional(),
  /** Relative % move vs previous observation (e.g. 0.1 = 10%). */
  yes_price_move_pct: z.number().nonnegative().optional(),
  /**
   * Direction the yes price must have moved for the move conditions above.
   * Default "any" (original behaviour: absolute move in either direction).
   */
  move_direction: z.enum(["up", "down", "any"]).default("any"),
  /**
   * Ignore the prior observation if it is older than this, so "moved since the
   * last check" doesn't silently become "moved since yesterday" when runs are sparse.
   */
  max_prior_age_minutes: z.number().positive().optional(),
  /** Preferred side when entering. Default yes. */
  side: z.enum(["yes", "no"]).default("yes"),
});

/**
 * Exit conditions for paper (and any future live) positions.
 * Prices are for the contract you HOLD: the YES price for `side: yes`,
 * the NO price for `side: no`. Triggers use the price you could sell at
 * (bid side when the adapter has quotes), not the mid.
 */
export const ExitConditionsSchema = z.object({
  /** Exit when the held contract is worth at least this (0–1). */
  take_profit_price: z.number().min(0).max(1).optional(),
  /** Exit when the held contract is worth at most this (0–1). */
  stop_loss_price: z.number().min(0).max(1).optional(),
  /** Exit when return vs entry price reaches +X (e.g. 0.2 = +20%). */
  take_profit_pct: z.number().positive().optional(),
  /** Exit when return vs entry price reaches −X (e.g. 0.3 = −30%). */
  stop_loss_pct: z.number().positive().max(1).optional(),
  /** Exit when hours to resolve drop below this. */
  max_hours_to_resolve: z.number().positive().optional(),
  /** Exit after holding this many hours. */
  max_hold_hours: z.number().positive().optional(),
}).optional();

export const RiskSchema = z.object({
  /** Fraction of bankroll per new position (e.g. 0.25 = 25%). */
  position_size_fraction: z.number().positive().max(1).default(0.25),
  /** Hard cap in USD (paper bankroll units). */
  max_position_usd: z.number().positive().optional(),
  max_open_positions: z.number().int().positive().default(5),
  /**
   * After N consecutive losing paper/live closes, pause new entries
   * until the cooldown elapses.
   */
  fire_after_n_losses: z.number().int().positive().default(3),
  /** Hours to stay paused after consecutive-loss trip. */
  pause_hours_after_losses: z.number().positive().default(24),
  /** Cap absolute daily realized paper/live loss (USD). */
  daily_loss_cap_usd: z.number().positive().optional(),
  /** Assumed bankroll for fraction sizing in paper mode. */
  bankroll_usd: z.number().positive().default(1000),
  /** Don't re-enter the same market for this many hours after an exit. */
  reentry_cooldown_hours: z.number().nonnegative().default(24),
});

/** Paper-fill realism knobs. Platform fee models live in the adapters. */
export const PaperSchema = z.object({
  /** Extra adverse price per fill on top of bid/ask (0–1, e.g. 0.01 = 1¢). */
  slippage: z.number().min(0).max(0.2).default(0),
  /** Charge the adapter's estimated taker fee on paper fills. */
  include_fees: z.boolean().default(true),
});

export const RuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean().default(true),
  /** alert | paper | live — live still requires env gates at runtime. */
  action: z.enum(["alert", "paper", "live"]).default("alert"),
  filters: MarketFiltersSchema.default({}),
  entry: EntryConditionsSchema.default({ side: "yes" }),
  exit: ExitConditionsSchema,
  risk: RiskSchema.default({
    position_size_fraction: 0.25,
    max_open_positions: 5,
    fire_after_n_losses: 3,
    pause_hours_after_losses: 24,
    bankroll_usd: 1000,
  }),
  paper: PaperSchema.default({}),
});

export const RulesFileSchema = z.object({
  version: z.literal(1).default(1),
  rules: z.array(RuleSchema).min(1),
}).superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.rules.forEach((r, i) => {
    if (seen.has(r.id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules", i, "id"],
        message: `Duplicate rule id "${r.id}" — ids key the paper ledger, so they must be unique`,
      });
    }
    seen.add(r.id);
  });
});

export type MarketFilters = z.infer<typeof MarketFiltersSchema>;
export type EntryConditions = z.infer<typeof EntryConditionsSchema>;
export type ExitConditions = z.infer<typeof ExitConditionsSchema>;
export type RiskConfig = z.infer<typeof RiskSchema>;
export type PaperConfig = z.infer<typeof PaperSchema>;
export type Rule = z.infer<typeof RuleSchema>;
export type RulesFile = z.infer<typeof RulesFileSchema>;
