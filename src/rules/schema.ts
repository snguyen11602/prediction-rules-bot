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

/** Rule id the arbitrage strategy uses in the ledger, risk state and dashboard. */
export const ARB_RULE_ID = "arbitrage";

/**
 * Arbitrage: buy a set of contracts whose combined payout is guaranteed, for
 * less than that payout (after fees and slippage).
 *  - cross_platform: same question on Kalshi and Polymarket → YES on one, NO on the other.
 *  - same_platform: an event whose outcomes are mutually exclusive (only one can
 *    resolve YES) → buy NO on every outcome when YES prices add up to more than $1,
 *    or YES on every outcome when they add up to less (only if one of them must win).
 */
export const ArbitrageSchema = z.object({
  enabled: z.boolean().default(true),
  /** alert = report opportunities only; paper = also open hypothetical positions. */
  action: z.enum(["alert", "paper"]).default("paper"),
  name: z.string().default("Arbitrage"),
  /** Minimum locked-in profit per $1 of guaranteed payout, after fees + slippage (0.02 = 2¢). */
  min_edge: z.number().min(0).max(0.5).default(0.02),
  /** Skip arbs that would tie money up longer than this (hours until the last leg closes). */
  max_hours_to_resolve: z.number().positive().default(1440),
  /** Skip arbs where any leg closes sooner than this — quotes go stale right before resolution. */
  min_hours_to_resolve: z.number().nonnegative().default(1),
  /** Sell every leg early when that already pays at least the guaranteed payout. */
  unwind_early: z.boolean().default(true),
  cross_platform: z
    .object({
      enabled: z.boolean().default(true),
      /** Look for pairs automatically by title (they're reported; see auto_trade). */
      auto_match: z.boolean().default(true),
      /**
       * Paper-trade automatic pairs too. Off by default: a wrong match is two bets that can
       * both lose, so automatic pairs only alert until you confirm them (npm run arb:confirm).
       */
      auto_trade: z.boolean().default(false),
      /** Title similarity needed for an automatic pair (0–1). */
      min_score: z.number().min(0).max(1).default(0.5),
      /** Close times of the two markets must be this close (hours). */
      max_close_gap_hours: z.number().nonnegative().default(168),
      /**
       * Automatic pairs whose prices differ by more than this are skipped as
       * probably-not-the-same-question. Real arbs are a few cents.
       */
      max_price_gap: z.number().min(0).max(1).default(0.15),
      /** Markets fetched per platform when looking for pairs. */
      scan_limit: z.number().int().positive().max(2000).default(400),
      /** Confirmed / blocked pairs, relative to the rules file's folder. */
      pairs_file: z.string().default("arb-pairs.yaml"),
    })
    .default({}),
  same_platform: z
    .object({
      enabled: z.boolean().default(true),
      /** Events fetched per platform (most liquid first where the API allows). */
      scan_events: z.number().int().positive().max(1000).default(100),
      /** Ignore events with more open outcomes than this (capital per set grows with outcomes). */
      max_outcomes: z.number().int().min(2).max(100).default(30),
      /** NO on every outcome when YES bids sum above $1. Safe whenever outcomes are mutually exclusive. */
      no_basket: z.boolean().default(true),
      /**
       * YES on every outcome when YES asks sum below $1. Only safe when one listed outcome must
       * win; Polymarket's "Other" outcomes can change meaning, so adapters rarely guarantee it. Off by default.
       */
      yes_basket: z.boolean().default(false),
    })
    .default({}),
  risk: RiskSchema.default({
    position_size_fraction: 0.1,
    bankroll_usd: 1000,
    max_position_usd: 100,
    max_open_positions: 5,
    fire_after_n_losses: 2,
    pause_hours_after_losses: 48,
    daily_loss_cap_usd: 50,
    reentry_cooldown_hours: 24,
  }),
  paper: PaperSchema.default({ slippage: 0.005, include_fees: true }),
});

const PairRefSchema = z.object({
  kalshi: z.string().min(1),
  polymarket: z.coerce.string().min(1),
});

/** rules/arb-pairs.yaml — pairs you've checked by hand. */
export const ArbPairsFileSchema = z.object({
  /** Same question on both platforms. `invert: true` when Polymarket YES means Kalshi NO. */
  confirmed: z
    .array(PairRefSchema.extend({ invert: z.boolean().default(false), note: z.string().optional() }))
    .nullish()
    .transform((v) => v ?? []),
  /** Look-alike markets that are NOT the same question; never traded. */
  blocked: z
    .array(PairRefSchema.extend({ note: z.string().optional() }))
    .nullish()
    .transform((v) => v ?? []),
});

export const RulesFileSchema = z.object({
  version: z.literal(1).default(1),
  rules: z.array(RuleSchema).min(1),
  arbitrage: ArbitrageSchema.optional(),
}).superRefine((file, ctx) => {
  if (file.arbitrage) {
    file.rules.forEach((r, i) => {
      if (r.id === ARB_RULE_ID) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", i, "id"],
          message: `Rule id "${ARB_RULE_ID}" is reserved for the arbitrage strategy`,
        });
      }
    });
  }
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
export type ArbitrageConfig = z.infer<typeof ArbitrageSchema>;
export type ArbPairsFile = z.infer<typeof ArbPairsFileSchema>;

/** The arbitrage strategy as a Rule, so the shared risk engine (sizing, caps, loss pause) applies unchanged. */
export function arbitrageAsRule(cfg: ArbitrageConfig): Rule {
  return RuleSchema.parse({
    id: ARB_RULE_ID,
    name: cfg.name,
    enabled: cfg.enabled,
    action: cfg.action,
    risk: cfg.risk,
    paper: cfg.paper,
  });
}
