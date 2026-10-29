import type { Rule } from "../rules/schema.js";
import type { NormalizedMarket, SignalSide } from "../types.js";
import type { Tick } from "./series.js";
import { describeMove, detectUnusualMove, type UnusualMove } from "./unusual.js";
import { cents, hours, usd, type Check } from "./trace.js";

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




/** Every configured filter as a check, in order (each one is evaluated, for the trace). */
export function filterChecks(rule: Rule, market: NormalizedMarket, now = new Date()): Check[] {
  const f = rule.filters;
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ stage: "filters", name, ok, detail });
  const platform = market.platform === "kalshi" ? "Kalshi" : "Polymarket";
  if (f.platforms?.length) add("Platform", f.platforms.includes(market.platform), `${platform}${f.platforms.includes(market.platform) ? " is" : " isn't"} in this rule's platforms`);
  if (f.keywords_any?.length) {
    const hit = f.keywords_any.find((k) => market.title.toLowerCase().includes(k.toLowerCase()));
    add("Topic", !!hit, hit ? `title mentions "${hit}"` : `title has none of: ${f.keywords_any.slice(0, 5).join(", ")}${f.keywords_any.length > 5 ? "…" : ""}`);
  }
  if (f.keywords_all?.length) {
    const missing = f.keywords_all.filter((k) => !market.title.toLowerCase().includes(k.toLowerCase()));
    add("Required words", !missing.length, missing.length ? `title is missing "${missing[0]}"` : `title has ${f.keywords_all.join(", ")}`);
  }
  if (f.keywords_exclude?.length) {
    const hit = f.keywords_exclude.find((k) => market.title.toLowerCase().includes(k.toLowerCase()));
    add("Excluded words", !hit, hit ? `title contains "${hit}"` : "no excluded words");
  }
  if (f.min_price != null || f.max_price != null) {
    const lo = f.min_price ?? 0;
    const hi = f.max_price ?? 1;
    const ok = market.yesPrice >= lo && market.yesPrice <= hi;
    add("Price band", ok, `YES ${cents(market.yesPrice)} is ${ok ? "within" : "outside"} ${cents(lo)}–${cents(hi)}`);
  }
  if (f.min_liquidity_usd != null) {
    const v = market.liquidityUsd;
    add("Liquidity", v != null && v >= f.min_liquidity_usd, v == null ? "platform gave no liquidity" : `${usd(v)} ${v >= f.min_liquidity_usd ? "≥" : "<"} ${usd(f.min_liquidity_usd)}`);
  }
  if (f.min_volume_24h_usd != null) {
    const v = market.volume24hUsd;
    add("24h volume", v != null && v >= f.min_volume_24h_usd, v == null ? "platform gave no volume" : `${usd(v)} ${v >= f.min_volume_24h_usd ? "≥" : "<"} ${usd(f.min_volume_24h_usd)}`);
  }
  if (f.max_spread != null) {
    if (market.yesBid == null || market.yesAsk == null) add("Spread", false, "no bid or no ask (can't trade at a fair price)");
    else {
      const sp = market.yesAsk - market.yesBid;
      add("Spread", sp <= f.max_spread + 1e-9, `${cents(market.yesBid)} bid / ${cents(market.yesAsk)} ask = ${cents(sp)} ${sp <= f.max_spread + 1e-9 ? "≤" : ">"} ${cents(f.max_spread)}`);
    }
  }
  if (f.min_hours_to_resolve != null || f.max_hours_to_resolve != null) {
    const hrs = hoursToResolve(market, now);
    const lo = f.min_hours_to_resolve;
    const hi = f.max_hours_to_resolve;
    const ok = hrs != null && (lo == null || hrs >= lo) && (hi == null || (hrs <= hi && hrs >= 0));
    const range = lo != null && hi != null ? `${hours(lo)}–${hours(hi)}` : lo != null ? `≥ ${hours(lo)}` : `≤ ${hours(hi)}`;
    add("Time to resolve", ok, hrs == null ? "no close date" : `closes in ${hours(hrs)} (needs ${range})`);
  }
  return out;
}

export function marketPassesFilters(rule: Rule, market: NormalizedMarket, now = new Date()): boolean {
  return filterChecks(rule, market, now).every((c) => c.ok);
}

export interface EntryTrace {
  checks: Check[];
  match: EvalMatch | null;
}

/**
 * Filters + signal checks for one rule and market, in order, stopping at the first
 * failure. `match` is what evaluateEntry returns.
 */
export function traceEntry(
  rule: Rule,
  market: NormalizedMarket,
  prior?: PriorPrice,
  now = new Date(),
  ctx: EvalContext = {},
): EntryTrace {
  const checks = filterChecks(rule, market, now);
  const firstBad = checks.findIndex((c) => !c.ok);
  if (firstBad >= 0) return { checks: checks.slice(0, firstBad + 1), match: null };

  const e = rule.entry;
  const reasons: string[] = [];
  let moveDir: "up" | "down" | undefined;
  let unusual: UnusualMove | undefined;
  const sig = (name: string, ok: boolean, detail: string) => checks.push({ stage: "signal", name, ok, detail });
  const fail = (name: string, detail: string): EntryTrace => {
    sig(name, false, detail);
    return { checks, match: null };
  };

  if (e.unusual_move) {
    const res = detectUnusualMove(ctx.series ?? [], now.getTime(), e.unusual_move);
    if (e.unusual_move.mode === "require") {
      if (!res.move) return fail("Unusual move", res.reason);
      unusual = res.move;
      moveDir = res.move.direction;
      reasons.push(describeMove(res.move));
      sig("Unusual move", true, describeMove(res.move));
    } else if (res.move) {
      return fail("Not an informed move", `${describeMove(res.move)} — staying out`);
    } else if (res.insufficient && e.unusual_move.on_missing_data === "skip") {
      return fail("Not an informed move", `can't tell yet: ${res.reason} — staying out`);
    } else {
      sig("Not an informed move", true, res.insufficient ? `not enough data (${res.reason}); allowed by on_missing_data` : `nothing unusual (${res.reason})`);
    }
  }

  if (e.yes_price_above != null) {
    if (market.yesPrice < e.yes_price_above) return fail("YES at least", `YES ${cents(market.yesPrice)} < ${cents(e.yes_price_above)}`);
    reasons.push(`yes>=${e.yes_price_above}`);
    sig("YES at least", true, `YES ${cents(market.yesPrice)} ≥ ${cents(e.yes_price_above)}`);
  }
  if (e.yes_price_below != null) {
    if (market.yesPrice > e.yes_price_below) return fail("YES at most", `YES ${cents(market.yesPrice)} > ${cents(e.yes_price_below)}`);
    reasons.push(`yes<=${e.yes_price_below}`);
    sig("YES at most", true, `YES ${cents(market.yesPrice)} ≤ ${cents(e.yes_price_below)}`);
  }

  if (e.yes_price_move_abs != null || e.yes_price_move_pct != null) {
    if (!prior) return fail("Price move", "no earlier price to compare yet (needs a previous check)");
    const ageMin = (now.getTime() - new Date(prior.at).getTime()) / 60_000;
    if (e.max_prior_age_minutes != null && !(ageMin <= e.max_prior_age_minutes)) {
      return fail("Price move", `last price is ${Math.round(ageMin)}m old (max ${e.max_prior_age_minutes}m)`);
    }
    const delta = market.yesPrice - prior.yesPrice;
    moveDir ??= delta > 0 ? "up" : delta < 0 ? "down" : undefined;
    const moved = `${delta >= 0 ? "+" : "−"}${cents(Math.abs(delta))} in ${Math.round(ageMin)}m (${cents(prior.yesPrice)} → ${cents(market.yesPrice)})`;
    if (e.move_direction === "up" && delta <= 0) return fail("Price move", `${moved}, needs a rise`);
    if (e.move_direction === "down" && delta >= 0) return fail("Price move", `${moved}, needs a drop`);
    const abs = Math.abs(delta);
    if (e.yes_price_move_abs != null) {
      if (abs < e.yes_price_move_abs) return fail("Price move", `${moved}, needs ≥ ${cents(e.yes_price_move_abs)}`);
      reasons.push(`abs_move=${delta >= 0 ? "+" : "-"}${abs.toFixed(4)}`);
    }
    if (e.yes_price_move_pct != null) {
      const pct = abs / Math.max(prior.yesPrice, 1e-6);
      if (pct < e.yes_price_move_pct) return fail("Price move", `${moved} = ${(pct * 100).toFixed(1)}%, needs ≥ ${(e.yes_price_move_pct * 100).toFixed(0)}%`);
      reasons.push(`pct_move=${(pct * 100).toFixed(2)}%`);
    }
    sig("Price move", true, moved);
  }

  if (reasons.length === 0) reasons.push("filters_matched");

  let side: SignalSide;
  if (e.side === "with_move" || e.side === "against_move") {
    if (!moveDir) return fail("Side", "no move to follow or fade");
    const up = moveDir === "up";
    side = (e.side === "with_move") === up ? "yes" : "no";
    sig("Side", true, `buy ${side.toUpperCase()} (${e.side === "with_move" ? "with" : "against"} the ${up ? "rise" : "drop"})`);
  } else {
    side = e.side;
    sig("Side", true, `buy ${side.toUpperCase()}`);
  }

  return { checks, match: { market, side, reason: reasons.join(", "), unusual } };
}

export function evaluateEntry(
  rule: Rule,
  market: NormalizedMarket,
  prior?: PriorPrice,
  now = new Date(),
  ctx: EvalContext = {},
): EvalMatch | null {
  return traceEntry(rule, market, prior, now, ctx).match;
}
