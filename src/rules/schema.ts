import { z } from "zod";
import { PLATFORM_IDS } from "../types.js";

/** The Polymarket exchanges a cross-platform pair can use (the other side is always Kalshi). */
export const POLYMARKET_VENUES = ["polymarket_us", "polymarket"] as const;

/** Shared rule schema — keep stable; extend with optional fields only. */

export const MarketFiltersSchema = z.object({
  /** Platforms this rule applies to. Empty / omitted = both. */
  platforms: z.array(z.enum(PLATFORM_IDS)).optional(),
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
  /**
   * Unusual move screen (needs a few hours of price history from watch / paper runs).
   * mode require: only enter on an unusual move. mode exclude: stay out while one is happening
   * (e.g. don't buy a "dip" that looks like informed selling).
   */
  unusual_move: z
    .object({
      mode: z.enum(["require", "exclude"]).default("require"),
      window_minutes: z.number().positive().default(60),
      lookback_hours: z.number().positive().default(12),
      min_move: z.number().min(0).max(1).default(0.05),
      min_zscore: z.number().nonnegative().default(3),
      min_volume_ratio: z.number().nonnegative().default(3),
      max_retrace: z.number().min(0).max(1).default(0.35),
      min_history_points: z.number().int().positive().default(12),
      direction: z.enum(["up", "down", "any"]).default("any"),
      /**
       * exclude mode only: what to do when there isn't enough history / volume to tell.
       * skip (default) = don't enter, since we can't rule out an informed move; allow = enter anyway.
       */
      on_missing_data: z.enum(["skip", "allow"]).default("skip"),
    })
    .optional(),
  /**
   * Side when entering. yes / no, or relative to the price move:
   * with_move = buy YES after a rise, NO after a drop; against_move = the opposite (buy the dip).
   */
  side: z.enum(["yes", "no", "with_move", "against_move"]).default("yes"),
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
  /** Sell when the held contract falls this far (0–1) below its best price since entry. */
  trailing_stop: z.number().positive().max(1).optional(),
  /** Only start trailing once the best price is at least this far above entry (lock in gains). */
  trailing_activation: z.number().min(0).max(1).optional(),
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
      /**
       * Which Polymarket to pair with Kalshi. polymarket_us (default) is the exchange US residents
       * can trade; polymarket is the global site (polymarket.com), which is close-only from the US.
       */
      with: z.enum(POLYMARKET_VENUES).default("polymarket_us"),
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
  /** Market id on the Polymarket exchange named by `platform`. */
  polymarket: z.coerce.string().min(1),
  /** polymarket_us or polymarket (global). Pairs written before Polymarket US support are global. */
  platform: z.enum(POLYMARKET_VENUES).default("polymarket"),
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

export const COPY_RULE_ID = "copy-leaders";

/**
 * Copy trading: follow global Polymarket's top traders (the only exchange that publishes other
 * traders' accounts) and copy their new bets onto the same market on Polymarket US or Kalshi.
 */
export const CopyTradingSchema = z.object({
  enabled: z.boolean().default(true),
  /** alert = report copyable bets only; paper = also take them in the paper ledger. */
  action: z.enum(["alert", "paper"]).default("paper"),
  name: z.string().default("Copy top Polymarket traders"),
  leaders: z
    .object({
      /** Leaderboard window the profit is measured over. */
      time_period: z.enum(["day", "week", "month", "all"]).default("month"),
      /** How many of the top accounts to check. */
      candidates: z.number().int().min(1).max(200).default(50),
      /** At least this many different markets traded (lifetime). */
      min_markets: z.number().int().nonnegative().default(50),
      /** Win rate over their most recent closed positions (count of winners / decided). */
      min_win_rate: z.number().min(0).max(1).default(0.55),
      /** Closed positions with a result needed before the win rate counts. */
      min_decided: z.number().int().positive().default(30),
      /** Leaderboard profit in the window, USD. */
      min_profit_usd: z.number().nonnegative().default(10_000),
      max_leaders: z.number().int().positive().max(50).default(10),
      refresh_hours: z.number().positive().default(6),
      /** Wallets to always follow / never follow (0x… proxy wallets). */
      include: z.array(z.string()).default([]),
      exclude: z.array(z.string()).default([]),
    })
    .default({}),
  copy: z
    .object({
      venues: z.array(z.enum(["polymarket_us", "kalshi"])).min(1).default(["polymarket_us", "kalshi"]),
      /** Ignore small fills (bots and test trades); USD = shares × price. */
      min_leader_trade_usd: z.number().nonnegative().default(500),
      /** Only copy bets this fresh. */
      max_trade_age_minutes: z.number().positive().default(30),
      /** Pay at most this much more than the leader did (0.03 = 3¢). */
      max_chase: z.number().min(0).max(0.5).default(0.03),
      /** The copy's price must be within this of the leader's market, or it's probably not the same bet. */
      max_price_gap: z.number().min(0).max(1).default(0.1),
      /** Title-match score needed when there's no exact game match. */
      min_score: z.number().min(0).max(1).default(0.6),
      /** Sell when the leader sells. */
      follow_sells: z.boolean().default(true),
      /** How often to check the leaders' new trades (seconds; fast mode checks between full checks). */
      poll_seconds: z.number().int().min(15).default(60),
      /**
       * When the same bet is on more than one venue, use this one if it costs no more than
       * `prefer_within` above the cheapest (price + fee per contract). none = always the cheapest.
       */
      prefer: z.enum(["kalshi", "polymarket_us", "none"]).default("kalshi"),
      prefer_within: z.number().min(0).max(0.1).default(0.01),
    })
    .default({}),
  exit: ExitConditionsSchema,
  risk: RiskSchema.default({
    position_size_fraction: 0.03,
    max_position_usd: 30,
    max_open_positions: 10,
    fire_after_n_losses: 4,
    pause_hours_after_losses: 24,
    daily_loss_cap_usd: 100,
    bankroll_usd: 1000,
    reentry_cooldown_hours: 12,
  }),
  paper: PaperSchema.default({ slippage: 0.005, include_fees: true }),
});

/**
 * Strategy league: the bot invents strategies (named like traders), backtests them on past prices,
 * paper-trades the roster, clones the winners and diagnoses + retires the losers.
 */
export const LeagueSchema = z.object({
  enabled: z.boolean().default(true),
  /** Bot-made strategies paper-trading at once. */
  roster_size: z.number().int().min(2).max(50).default(12),
  /**
   * Kinds of idea in play. dip_buyer and scalper are off by default: in backtests they lost in every
   * variant (game-market drops are usually real news, and quick flips can't cover fees). League
   * strategies of a type that's switched off stop opening trades and retire at the next round.
   */
  families: z
    .array(z.enum(["dip_buyer", "momentum", "favorite", "longshot_fade", "scalper"]))
    .min(1)
    .default(["momentum", "favorite", "longshot_fade"]),
  /** Finished trades needed before a strategy is ranked (or cloned, or retired for losing). */
  min_trades: z.number().int().positive().default(5),
  /** Each round: the top `winners` each get `clones_per_winner` clones… */
  winners: z.number().int().min(1).max(10).default(3),
  clones_per_winner: z.number().int().min(0).max(3).default(1),
  /** …and up to `retire` of the worst are diagnosed and retired. */
  retire: z.number().int().min(0).max(10).default(3),
  /** Your own paper rules can be cloned too (they're never retired). */
  clone_house_rules: z.boolean().default(true),
  /** Backtest window and resolution. */
  backtest_days: z.number().int().min(2).max(60).default(14),
  step_minutes: z.number().int().min(30).max(240).default(60),
  /** The last part of the window is held out: a winner must also make money there. */
  test_share: z.number().min(0.1).max(0.5).default(0.3),
  /** Markets with price history to load per platform. */
  markets_per_platform: z.number().int().min(10).max(500).default(120),
  /** paper:watch runs a league round this often. */
  evolve_every_hours: z.number().positive().default(24),
});

export const RulesFileSchema = z.object({
  version: z.literal(1).default(1),
  rules: z.array(RuleSchema).min(1),
  arbitrage: ArbitrageSchema.optional(),
  copy_trading: CopyTradingSchema.optional(),
  league: LeagueSchema.optional(),
}).superRefine((file, ctx) => {
  file.rules.forEach((r, i) => {
    for (const [reserved, what, used] of [
      [ARB_RULE_ID, "the arbitrage strategy", !!file.arbitrage],
      [COPY_RULE_ID, "copy trading", !!file.copy_trading],
    ] as const) {
      if (used && r.id === reserved) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["rules", i, "id"],
          message: `Rule id "${reserved}" is reserved for ${what}`,
        });
      }
    }
  });
  file.rules.forEach((r, i) => {
    const relative = r.entry.side === "with_move" || r.entry.side === "against_move";
    const hasMove =
      r.entry.unusual_move?.mode === "require" || r.entry.yes_price_move_abs != null || r.entry.yes_price_move_pct != null;
    if (relative && !hasMove) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["rules", i, "entry", "side"],
        message: `side: ${r.entry.side} needs a move to follow — add unusual_move (mode: require) or yes_price_move_abs / _pct`,
      });
    }
  });
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
export type CopyTradingConfig = z.infer<typeof CopyTradingSchema>;
export type LeagueConfig = z.infer<typeof LeagueSchema>;

/** Copy trading as a Rule: shared sizing, caps, loss pause and exits. */
export function copyAsRule(cfg: CopyTradingConfig): Rule {
  return RuleSchema.parse({
    id: COPY_RULE_ID,
    name: cfg.name,
    enabled: cfg.enabled,
    action: cfg.action,
    exit: cfg.exit,
    risk: cfg.risk,
    paper: cfg.paper,
  });
}

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
