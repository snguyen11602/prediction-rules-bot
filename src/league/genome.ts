import { RuleSchema, type Rule } from "../rules/schema.js";
import type { Traits } from "./personas.js";

/**
 * Strategy "DNA": a rule config the league can invent, clone and mutate. Rookies are drawn from a
 * few families of ideas; clones copy their parent's rule and nudge its numbers, more or less
 * depending on the parent's creativity. Everything stays a normal Rule, run by the same engine.
 */

export type FamilyId = "dip_buyer" | "momentum" | "favorite" | "longshot_fade" | "scalper" | "custom";

export const FAMILIES: Record<FamilyId, { style: string; idea: string }> = {
  dip_buyer: { style: "The Dip Hunter", idea: "buys sharp drops and sells the bounce" },
  momentum: { style: "The Trend Rider", idea: "buys in the direction of a sharp move" },
  favorite: { style: "The Closer", idea: "buys heavy favorites close to the finish" },
  longshot_fade: { style: "The Skeptic", idea: "bets against long shots close to the finish" },
  scalper: { style: "The Scalper", idea: "flips small moves in tight markets fast" },
  custom: { style: "The Original", idea: "a strategy you wrote" },
};

/** Rule settings without id/name (those come from the league member). */
export type RuleBody = Omit<Rule, "id" | "name">;

/**
 * Lessons from the first backtests: a round trip costs ~5% in fees plus the bid/ask gap, so small
 * targets and quick time limits mostly pay costs. Every league strategy therefore aims to win at
 * least MIN_REWARD_RISK × what it risks, and gets at least MIN_HOLD_HOURS for the move to come.
 */
export const MIN_REWARD_RISK = 2;
export const MIN_HOLD_HOURS = 48;

/** Apply the profit-target and time-limit floors (used for rookies, clones and existing members). */
export function withRewardRisk<T extends Pick<RuleBody, "exit">>(b: T): T {
  if (!b.exit) return b;
  const x = { ...b.exit };
  if (x.stop_loss_pct != null) x.take_profit_pct = Math.max(x.take_profit_pct ?? 0, Math.round(MIN_REWARD_RISK * x.stop_loss_pct * 100) / 100);
  if (x.max_hold_hours != null) x.max_hold_hours = Math.max(x.max_hold_hours, MIN_HOLD_HOURS);
  return { ...b, exit: x };
}

const round = (v: number, step: number) => Math.round(v / step) * step;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const between = (r: () => number, lo: number, hi: number, step = 0.01) => round(lo + r() * (hi - lo), step);

/** Work ethic → how many trades at once and how soon it may re-enter a market. */
function riskFor(t: Traits) {
  return {
    position_size_fraction: 0.05,
    bankroll_usd: 1000,
    max_position_usd: 50,
    max_open_positions: Math.round(2 + t.hustle * 6),
    fire_after_n_losses: 3,
    pause_hours_after_losses: 12,
    daily_loss_cap_usd: 100,
    reentry_cooldown_hours: round(24 - t.hustle * 22, 1),
  };
}

/** Knowledge → extra safety checks before a trade. */
function filtersFor(t: Traits, base: Record<string, unknown>) {
  const f: Record<string, unknown> = { platforms: ["kalshi", "polymarket_us"], ...base };
  f.max_spread = round(0.05 - t.knowledge * 0.035, 0.005); // 5¢ → 1.5¢
  if (t.knowledge > 0.4) f.keywords_exclude = ["parlay", "same game", "mention"];
  if (t.knowledge > 0.6 && f.min_hours_to_resolve == null) f.min_hours_to_resolve = 2;
  return f;
}

export function rookieRule(family: Exclude<FamilyId, "custom">, t: Traits, r: () => number): RuleBody {
  const paper = { slippage: 0.005, include_fees: true };
  let body: Record<string, unknown>;
  switch (family) {
    case "dip_buyer":
    case "momentum": {
      const lo = between(r, 0.1, 0.35);
      body = {
        filters: filtersFor(t, { min_price: lo, max_price: between(r, Math.max(lo + 0.25, 0.6), 0.9) }),
        entry: {
          side: family === "dip_buyer" ? "against_move" : "with_move",
          yes_price_move_abs: between(r, 0.03, 0.1),
          move_direction: family === "dip_buyer" ? "down" : r() < 0.5 ? "up" : "any",
          max_prior_age_minutes: round(between(r, 15, 120, 1), 5),
        },
        exit: {
          take_profit_pct: between(r, 0.05, 0.25),
          stop_loss_pct: between(r, 0.05, 0.3),
          trailing_stop: between(r, 0.01, 0.05),
          trailing_activation: between(r, 0.01, 0.05),
          max_hold_hours: round(between(r, MIN_HOLD_HOURS, 168, 1), 1),
        },
      };
      break;
    }
    case "favorite": {
      const lo = between(r, 0.8, 0.9);
      body = {
        filters: filtersFor(t, { min_price: lo, max_price: between(r, lo + 0.03, 0.97), min_hours_to_resolve: between(r, 1, 12, 1), max_hours_to_resolve: between(r, 24, 168, 1) }),
        entry: { side: "yes" },
        exit: { stop_loss_price: between(r, 0.55, 0.8), take_profit_price: between(r, 0.97, 0.995, 0.005) },
      };
      break;
    }
    case "longshot_fade": {
      const hi = between(r, 0.08, 0.2);
      body = {
        filters: filtersFor(t, { min_price: between(r, 0.02, hi - 0.03), max_price: hi, min_hours_to_resolve: between(r, 1, 12, 1), max_hours_to_resolve: between(r, 24, 168, 1) }),
        entry: { side: "no" },
        exit: { stop_loss_price: between(r, 0.55, 0.8), take_profit_price: between(r, 0.97, 0.995, 0.005) },
      };
      break;
    }
    case "scalper": {
      body = {
        filters: filtersFor(t, { min_price: between(r, 0.2, 0.35), max_price: between(r, 0.65, 0.8), max_spread: between(r, 0.01, 0.02, 0.005) }),
        entry: { side: "against_move", yes_price_move_abs: between(r, 0.02, 0.05), move_direction: "any", max_prior_age_minutes: 15 },
        exit: { take_profit_pct: between(r, 0.06, 0.2), stop_loss_pct: between(r, 0.03, 0.1), max_hold_hours: between(r, MIN_HOLD_HOURS, 96, 1) },
      };
      // Scalpers always want the tightest spread.
      (body.filters as Record<string, unknown>).max_spread = between(r, 0.01, 0.02, 0.005);
      break;
    }
  }
  return withRewardRisk(toBody({ enabled: true, action: "paper", ...body, risk: riskFor(t), paper }));
}

/** Validate through the shared schema (fills defaults, rejects nonsense). */
export function toBody(raw: Record<string, unknown>): RuleBody {
  const { id: _i, name: _n, ...rest } = RuleSchema.parse({ id: "x", name: "x", ...raw });
  return rest;
}

/** Numbers a clone may nudge, with sensible bounds. */
const KNOBS: Array<{ path: [keyof RuleBody, string]; lo: number; hi: number; step: number }> = [
  { path: ["filters", "min_price"], lo: 0.01, hi: 0.95, step: 0.01 },
  { path: ["filters", "max_price"], lo: 0.05, hi: 0.99, step: 0.01 },
  { path: ["filters", "max_spread"], lo: 0.005, hi: 0.1, step: 0.005 },
  { path: ["filters", "min_hours_to_resolve"], lo: 0, hi: 72, step: 1 },
  { path: ["filters", "max_hours_to_resolve"], lo: 6, hi: 2160, step: 1 },
  { path: ["entry", "yes_price_move_abs"], lo: 0.01, hi: 0.3, step: 0.005 },
  { path: ["entry", "max_prior_age_minutes"], lo: 5, hi: 720, step: 5 },
  { path: ["exit", "take_profit_price"], lo: 0.5, hi: 0.995, step: 0.005 },
  { path: ["exit", "stop_loss_price"], lo: 0.02, hi: 0.95, step: 0.01 },
  { path: ["exit", "take_profit_pct"], lo: 0.01, hi: 2, step: 0.01 },
  { path: ["exit", "stop_loss_pct"], lo: 0.01, hi: 0.9, step: 0.01 },
  { path: ["exit", "trailing_stop"], lo: 0.005, hi: 0.3, step: 0.005 },
  { path: ["exit", "trailing_activation"], lo: 0, hi: 0.3, step: 0.005 },
  { path: ["exit", "max_hold_hours"], lo: 0.25, hi: 720, step: 0.25 },
];

/**
 * A clone: same idea, nudged numbers. Creativity sets how far (±5% for a careful parent, up to
 * ±35% for a creative one), work ethic and knowledge come from the child's own (inherited) traits.
 */
export function mutate(parent: RuleBody, parentTraits: Traits, childTraits: Traits, r: () => number): RuleBody {
  const sigma = 0.05 + 0.3 * parentTraits.creativity;
  const gauss = () => {
    const u = Math.max(1e-9, r());
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
  };
  const child = JSON.parse(JSON.stringify(parent)) as Record<string, Record<string, unknown> | undefined>;
  for (const k of KNOBS) {
    const sect = child[k.path[0]];
    const v = sect?.[k.path[1]];
    if (typeof v !== "number") continue;
    sect![k.path[1]] = clamp(round(v * (1 + gauss() * sigma), k.step), k.lo, k.hi);
  }
  const f = child.filters as Record<string, number | unknown> | undefined;
  if (f && typeof f.min_price === "number" && typeof f.max_price === "number" && f.min_price >= f.max_price - 0.02) {
    f.max_price = clamp((f.min_price as number) + 0.05, 0.05, 0.99);
  }
  // A creative parent sometimes passes on a bigger idea change.
  const entry = child.entry as Record<string, unknown> | undefined;
  if (entry && (entry.side === "with_move" || entry.side === "against_move") && r() < 0.15 * parentTraits.creativity) {
    entry.side = entry.side === "with_move" ? "against_move" : "with_move";
  }
  const exit = child.exit as Record<string, unknown> | undefined;
  if (exit && typeof exit.trailing_stop !== "number" && r() < 0.2 * parentTraits.creativity) {
    exit.trailing_stop = 0.03;
    exit.trailing_activation = 0.02;
  }
  return withRewardRisk(
    toBody({
      ...child,
      filters: { ...(child.filters ?? {}), max_spread: (child.filters?.max_spread as number | undefined) ?? round(0.05 - childTraits.knowledge * 0.035, 0.005) },
      risk: { ...(child.risk ?? {}), ...riskFor(childTraits) },
    }),
  );
}

/** Plain-English summary of what a rule does, for the strategy page. */
export function describeRule(b: RuleBody): string[] {
  const out: string[] = [];
  const f = b.filters;
  const c = (p?: number) => (p == null ? "?" : `${Math.round(p * 1000) / 10}¢`);
  if (f.min_price != null || f.max_price != null) out.push(`Looks at markets with YES between ${c(f.min_price ?? 0)} and ${c(f.max_price ?? 1)}.`);
  if (f.min_hours_to_resolve != null || f.max_hours_to_resolve != null) {
    out.push(`Only markets resolving in ${f.min_hours_to_resolve ?? 0}h–${f.max_hours_to_resolve != null ? `${f.max_hours_to_resolve}h` : "any time"}.`);
  }
  if (f.max_spread != null) out.push(`Skips markets with a bid/ask gap over ${c(f.max_spread)}.`);
  const e = b.entry;
  if (e.yes_price_move_abs != null) {
    const dir = e.move_direction === "down" ? "drops" : e.move_direction === "up" ? "rises" : "moves";
    const side = e.side === "against_move" ? "bets on a bounce back" : e.side === "with_move" ? "rides the move" : `buys ${e.side.toUpperCase()}`;
    out.push(`When YES ${dir} ${c(e.yes_price_move_abs)} or more since the last check${e.max_prior_age_minutes ? ` (within ${e.max_prior_age_minutes} min)` : ""}, it ${side}.`);
  } else out.push(`Buys ${e.side.toUpperCase()}.`);
  const x = b.exit ?? {};
  const exits: string[] = [];
  if (x.take_profit_pct != null) exits.push(`+${Math.round(x.take_profit_pct * 100)}% profit`);
  if (x.take_profit_price != null) exits.push(`worth ${c(x.take_profit_price)}`);
  if (x.stop_loss_pct != null) exits.push(`−${Math.round(x.stop_loss_pct * 100)}% loss`);
  if (x.stop_loss_price != null) exits.push(`falls to ${c(x.stop_loss_price)}`);
  if (x.trailing_stop != null) exits.push(`${c(x.trailing_stop)} off its high`);
  if (x.max_hold_hours != null) exits.push(`${x.max_hold_hours}h held`);
  out.push(exits.length ? `Sells at ${exits.join(", ")}, or when the market resolves.` : "Holds until the market resolves.");
  out.push(`Up to ${b.risk.max_open_positions} trades at once, ${Math.round(b.risk.position_size_fraction * 100)}% of its $${b.risk.bankroll_usd.toLocaleString("en-US")} each (max $${b.risk.max_position_usd ?? "—"}).`);
  return out;
}
