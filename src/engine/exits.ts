import type { ExitConditions } from "../rules/schema.js";
import type { NormalizedMarket, PaperExitReason } from "../types.js";
import { hoursToResolve } from "./evaluate.js";

/** The parts of an open position exit logic needs. */
export interface ExitablePosition {
  entryAt: string;
  entryPrice: number;
  peakMarkPrice?: number;
}

export interface ExitDecision {
  reason: PaperExitReason;
  detail: string;
}

const EPS = 1e-9;

/**
 * Decide whether an open position should be closed at `markPrice`
 * (the held contract's current sell price). Pure — no I/O, no platform branching.
 * Checked in order: stop loss → take profit → time to resolve → max hold.
 * Resolution is handled by the caller (it settles at 1/0, not at a mark).
 */
export function evaluateExit(
  exit: ExitConditions,
  position: ExitablePosition,
  market: NormalizedMarket,
  markPrice: number,
  now = new Date(),
  /**
   * Price the stops compare against (default: markPrice). The paper session passes the mid: a bid
   * that vanishes for a few seconds in a thin book isn't a real price, and selling there turned
   * winners into losers.
   */
  stopPrice = markPrice,
): ExitDecision | null {
  if (!exit) return null;
  const sret = position.entryPrice > 0 ? stopPrice / position.entryPrice - 1 : 0;
  const ret = position.entryPrice > 0 ? markPrice / position.entryPrice - 1 : 0;
  const pct = `${(ret * 100).toFixed(1)}%`;
  const what = stopPrice === markPrice ? "mark" : "mid";

  if (exit.stop_loss_price != null && stopPrice <= exit.stop_loss_price + EPS) {
    return { reason: "stop_loss", detail: `${what} ${stopPrice.toFixed(3)} <= stop ${exit.stop_loss_price}` };
  }
  if (exit.stop_loss_pct != null && sret <= -exit.stop_loss_pct + EPS) {
    return { reason: "stop_loss", detail: `return ${(sret * 100).toFixed(1)}% (${what}) <= -${(exit.stop_loss_pct * 100).toFixed(1)}%` };
  }
  if (exit.trailing_stop != null && position.peakMarkPrice != null) {
    const peak = Math.max(position.peakMarkPrice, markPrice);
    const armed = peak - position.entryPrice >= (exit.trailing_activation ?? 0) - EPS;
    if (armed && stopPrice <= peak - exit.trailing_stop + EPS) {
      return {
        reason: "trailing_stop",
        detail: `${what} ${stopPrice.toFixed(3)} is ${((peak - stopPrice) * 100).toFixed(1)}¢ below the high of ${peak.toFixed(3)}`,
      };
    }
  }
  if (exit.take_profit_price != null && markPrice >= exit.take_profit_price - EPS) {
    return { reason: "take_profit", detail: `mark ${markPrice.toFixed(3)} >= target ${exit.take_profit_price}` };
  }
  if (exit.take_profit_pct != null && ret >= exit.take_profit_pct - EPS) {
    return { reason: "take_profit", detail: `return ${pct} >= +${(exit.take_profit_pct * 100).toFixed(1)}%` };
  }
  if (exit.max_hours_to_resolve != null) {
    const hrs = hoursToResolve(market, now);
    if (hrs != null && hrs < exit.max_hours_to_resolve) {
      return { reason: "time_to_resolve", detail: `${hrs.toFixed(1)}h to resolve < ${exit.max_hours_to_resolve}h` };
    }
  }
  if (exit.max_hold_hours != null) {
    const held = (now.getTime() - new Date(position.entryAt).getTime()) / 3600_000;
    if (held >= exit.max_hold_hours) {
      return { reason: "max_hold", detail: `held ${held.toFixed(1)}h >= ${exit.max_hold_hours}h` };
    }
  }
  return null;
}

/** Loss-taking exits wait for a second look before selling. */
export const isLossExit = (r: PaperExitReason) => r === "stop_loss" || r === "trailing_stop";
/** A stop must still hold this long after it first fires (fast mode re-checks every few seconds). */
export const STOP_CONFIRM_SEC = 20;
/** Never sell into a book wider than this for the held side: it's an empty book, not a price. */
export const EXIT_MAX_SPREAD = 0.1;
