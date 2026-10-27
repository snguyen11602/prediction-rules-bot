import type { Rule } from "../rules/schema.js";
import type { NormalizedMarket, SignalSide } from "../types.js";
import type { Tick } from "./series.js";
import { describeMove, detectUnusualMove, type UnusualMove } from "./unusual.js";

export interface PriorPrice {
  yesPrice: number;
  at: string;
}

export interface EvalMatch {
  market: NormalizedMarket;
  side: SignalSide;
  reason: string;
  /** Set when the rule required an unusual move and one was found. */
  unusual?: UnusualMove;
}

export interface EvalContext {
  /** This market's recent price / volume snapshots (for unusual_move). */
  series?: Tick[];
}

export function hoursToResolve(market: NormalizedMarket, now: Date): number | undefined {
  if (!market.closesAt) return undefined;
  const t = new Date(market.closesAt).getTime();
  if (!Number.isFinite(t)) return undefined;
  return (t - now.getTime()) / 3600_000;
}

function includesAny(hay: string, needles?: string[]): boolean {
  if (!needles?.length) return true;
  const h = hay.toLowerCase();
  return needles.some((n) => h.includes(n.toLowerCase()));
}

function includesAll(hay: string, needles?: string[]): boolean {
  if (!needles?.length) return true;
  const h = hay.toLowerCase();
  return needles.every((n) => h.includes(n.toLowerCase()));
}

function excludesAny(hay: string, needles?: string[]): boolean {
  if (!needles?.length) return true;
  const h = hay.toLowerCase();
  return !needles.some((n) => h.includes(n.toLowerCase()));
}

export function marketPassesFilters(
  rule: Rule,
  market: NormalizedMarket,
  now = new Date(),
): boolean {
  const f = rule.filters;
  if (f.platforms?.length && !f.platforms.includes(market.platform)) return false;
  if (!includesAny(market.title, f.keywords_any)) return false;
  if (!includesAll(market.title, f.keywords_all)) return false;
  if (!excludesAny(market.title, f.keywords_exclude)) return false;
  if (f.min_price != null && market.yesPrice < f.min_price) return false;
  if (f.max_price != null && market.yesPrice > f.max_price) return false;
  if (f.min_liquidity_usd != null) {
    if (market.liquidityUsd == null || market.liquidityUsd < f.min_liquidity_usd) {
      return false;
    }
  }
  if (f.min_volume_24h_usd != null) {
    if (market.volume24hUsd == null || market.volume24hUsd < f.min_volume_24h_usd) {
      return false;
    }
  }
  if (f.max_spread != null) {
    if (market.yesBid == null || market.yesAsk == null) return false;
    if (market.yesAsk - market.yesBid > f.max_spread + 1e-9) return false;
  }
  const hrs = hoursToResolve(market, now);
  if (f.max_hours_to_resolve != null) {
    if (hrs == null || hrs > f.max_hours_to_resolve || hrs < 0) return false;
  }
  if (f.min_hours_to_resolve != null) {
    if (hrs == null || hrs < f.min_hours_to_resolve) return false;
  }
  return true;
}

export function evaluateEntry(
  rule: Rule,
  market: NormalizedMarket,
  prior?: PriorPrice,
  now = new Date(),
  ctx: EvalContext = {},
): EvalMatch | null {
  if (!marketPassesFilters(rule, market, now)) return null;

  const e = rule.entry;
  const reasons: string[] = [];
  let moveDir: "up" | "down" | undefined;
  let unusual: UnusualMove | undefined;

  if (e.unusual_move) {
    const res = detectUnusualMove(ctx.series ?? [], now.getTime(), e.unusual_move);
    if (e.unusual_move.mode === "require") {
      if (!res.move) return null;
      unusual = res.move;
      moveDir = res.move.direction;
      reasons.push(describeMove(res.move));
    } else if (res.move) {
      return null; // exclude: something unusual (possibly informed) is happening — stay out
    }
  }

  if (e.yes_price_above != null && market.yesPrice < e.yes_price_above) return null;
  if (e.yes_price_above != null) reasons.push(`yes>=${e.yes_price_above}`);

  if (e.yes_price_below != null && market.yesPrice > e.yes_price_below) return null;
  if (e.yes_price_below != null) reasons.push(`yes<=${e.yes_price_below}`);

  if (e.yes_price_move_abs != null || e.yes_price_move_pct != null) {
    if (!prior) return null; // need history (watch mode / previous paper run)
    if (e.max_prior_age_minutes != null) {
      const ageMin = (now.getTime() - new Date(prior.at).getTime()) / 60_000;
      if (!(ageMin <= e.max_prior_age_minutes)) return null;
    }
    const delta = market.yesPrice - prior.yesPrice;
    moveDir ??= delta > 0 ? "up" : delta < 0 ? "down" : undefined;
    if (e.move_direction === "up" && delta <= 0) return null;
    if (e.move_direction === "down" && delta >= 0) return null;
    const abs = Math.abs(delta);
    if (e.yes_price_move_abs != null) {
      if (abs < e.yes_price_move_abs) return null;
      reasons.push(`abs_move=${delta >= 0 ? "+" : "-"}${abs.toFixed(4)}`);
    }
    if (e.yes_price_move_pct != null) {
      const base = Math.max(prior.yesPrice, 1e-6);
      const pct = abs / base;
      if (pct < e.yes_price_move_pct) return null;
      reasons.push(`pct_move=${(pct * 100).toFixed(2)}%`);
    }
  }

  if (reasons.length === 0) {
    reasons.push("filters_matched");
  }

  let side: SignalSide;
  if (e.side === "with_move" || e.side === "against_move") {
    if (!moveDir) return null; // relative sides need a move to be relative to
    const up = moveDir === "up";
    side = (e.side === "with_move") === up ? "yes" : "no";
  } else {
    side = e.side;
  }

  return {
    market,
    side,
    reason: reasons.join(", "),
    unusual,
  };
}
