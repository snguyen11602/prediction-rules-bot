import type { Rule, RiskConfig } from "../rules/schema.js";
import type { EngineEvent } from "../types.js";
import { usd, type Check } from "./trace.js";

export interface RiskState {
  consecutiveLosses: number;
  pausedUntil?: string;
  openPositions: number;
  /** YYYY-MM-DD in America/Los_Angeles-ish local date string from runner. */
  dayKey: string;
  dayPnlUsd: number;
  /**
   * Paper/live only: USD currently tied up in open positions and realized PnL
   * to date. When set, entries are blocked if they would exceed
   * bankroll_usd + realizedPnlUsd. Alert-only scans leave these undefined.
   */
  openExposureUsd?: number;
  realizedPnlUsd?: number;
}

export function defaultRiskState(dayKey: string): RiskState {
  return {
    consecutiveLosses: 0,
    openPositions: 0,
    dayKey,
    dayPnlUsd: 0,
  };
}

export function positionSizeUsd(risk: RiskConfig): number {
  const frac = risk.bankroll_usd * risk.position_size_fraction;
  if (risk.max_position_usd != null) return Math.min(frac, risk.max_position_usd);
  return frac;
}

/** Stops fill worse than their trigger: the planned loss is scaled by this for sizing. */
export const STOP_GAP_FACTOR = 1.5;

/** Worst-case loss as a share of the stake, from the rule's stop (if any) and the price paid. */
export function worstLossFraction(exit: Rule["exit"], entryPrice?: number): { fraction: number; why: string } {
  const planned: number[] = [];
  if (exit?.stop_loss_pct != null) planned.push(exit.stop_loss_pct);
  if (exit?.stop_loss_price != null && entryPrice != null && entryPrice > 0) planned.push(Math.max(0, (entryPrice - exit.stop_loss_price) / entryPrice));
  if (!planned.length) return { fraction: 1, why: "no stop loss: the whole stake is at risk" };
  const p = Math.min(...planned);
  const fraction = Math.min(1, p * STOP_GAP_FACTOR);
  return { fraction, why: `stop at −${(p * 100).toFixed(0)}%, sized for −${(fraction * 100).toFixed(0)}% (stops often fill worse)` };
}

/** Possible gain ÷ possible loss per contract, for a buy at `entryPrice`. */
export function rewardRisk(exit: Rule["exit"], entryPrice: number): number {
  const targets = [1];
  if (exit?.take_profit_price != null) targets.push(exit.take_profit_price);
  if (exit?.take_profit_pct != null) targets.push(entryPrice * (1 + exit.take_profit_pct));
  const gain = Math.max(0, Math.min(...targets) - entryPrice);
  const loss = entryPrice * worstLossFraction(exit, entryPrice).fraction;
  return loss > 0 ? gain / loss : Infinity;
}

export interface RiskCheckResult {
  ok: boolean;
  reason?: string;
  sizeUsd?: number;
  /** Every risk check in order, with numbers (for the decision trace). */
  checks: Check[];
}

/**
 * Gate new entries: consecutive-loss pause, open-position cap, daily loss cap,
 * and (when exposure is tracked) available paper bankroll.
 */
export function checkEntryRisk(
  rule: Rule,
  state: RiskState,
  now = new Date(),
  /** Price that would be paid for the held side (0–1), when known: used by the per-trade loss cap. */
  entryPrice?: number,
): RiskCheckResult {
  const risk = rule.risk;
  const checks: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ stage: "risk", name, ok, detail });
  const block = (reason: string): RiskCheckResult => ({ ok: false, reason, checks });

  // fire_after_n_losses: 0 = never pause (an old pause from before that setting no longer counts).
  const neverPause = risk.fire_after_n_losses === 0;
  const paused = !neverPause && !!state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime();
  add(
    "Losing-streak pause",
    !paused,
    neverPause
      ? "never pauses after losses (fire_after_n_losses: 0)"
      : paused
        ? `paused until ${new Date(state.pausedUntil!).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })} after ${risk.fire_after_n_losses} losses in a row`
        : `not paused (${state.consecutiveLosses} of ${risk.fire_after_n_losses} losses in a row)`,
  );
  if (paused) return block(`paused until ${state.pausedUntil} after ${risk.fire_after_n_losses} consecutive losses`);

  const full = state.openPositions >= risk.max_open_positions;
  add("Open positions", !full, `${state.openPositions} of ${risk.max_open_positions} open`);
  if (full) return block(`max open positions (${risk.max_open_positions}) reached`);

  if (risk.daily_loss_cap_usd != null) {
    const hit = state.dayPnlUsd <= -Math.abs(risk.daily_loss_cap_usd);
    add("Daily loss cap", !hit, `today ${usd(state.dayPnlUsd)} vs cap −${usd(risk.daily_loss_cap_usd)}`);
    if (hit) return block(`daily loss cap $${risk.daily_loss_cap_usd} hit (pnl=${state.dayPnlUsd.toFixed(2)})`);
  }

  if (risk.min_reward_risk != null && entryPrice != null) {
    const rr = rewardRisk(rule.exit, entryPrice);
    const ok = rr + 1e-9 >= risk.min_reward_risk;
    add("Reward vs risk", ok, `could gain ${rr.toFixed(2)}× what it could lose ${ok ? "≥" : "<"} ${risk.min_reward_risk}×`);
    if (!ok) return block(`reward:risk ${rr.toFixed(2)} is below ${risk.min_reward_risk}`);
  }

  let sizeUsd = positionSizeUsd(risk);
  let lossNote = "";
  if (risk.max_loss_per_trade_usd != null) {
    const { fraction, why } = worstLossFraction(rule.exit, entryPrice);
    const most = risk.max_loss_per_trade_usd / fraction;
    const cut = most < sizeUsd - 1e-9;
    if (cut) sizeUsd = most;
    lossNote = `; ${cut ? `cut to ${usd(sizeUsd)} so` : "already within"} the most it can lose is ${usd(sizeUsd * fraction)} ≤ ${usd(risk.max_loss_per_trade_usd)} (${why})`;
  }
  if (state.openExposureUsd != null) {
    const equity = risk.bankroll_usd + (state.realizedPnlUsd ?? 0);
    const over = state.openExposureUsd + sizeUsd > equity + 1e-9;
    add("Bankroll", !over, `${usd(state.openExposureUsd)} in play + ${usd(sizeUsd)} new ${over ? ">" : "≤"} ${usd(equity)} paper bankroll`);
    if (over) {
      return block(`insufficient bankroll: $${state.openExposureUsd.toFixed(2)} open + $${sizeUsd.toFixed(2)} new > $${equity.toFixed(2)} equity`);
    }
  }
  add("Position size", true, `${(risk.position_size_fraction * 100).toFixed(0)}% of ${usd(risk.bankroll_usd)}${risk.max_position_usd != null ? `, capped at ${usd(risk.max_position_usd)}` : ""} = ${usd(positionSizeUsd(risk))}${lossNote}`);
  return { ok: true, sizeUsd, checks };
}

/** Record a closed paper/live outcome and maybe trip the consecutive-loss pause. */
export function applyOutcome(
  rule: Rule,
  state: RiskState,
  pnlUsd: number,
  now = new Date(),
): { state: RiskState; events: EngineEvent[] } {
  const events: EngineEvent[] = [];
  const next: RiskState = {
    ...state,
    openPositions: Math.max(0, state.openPositions - 1),
    dayPnlUsd: state.dayPnlUsd + pnlUsd,
  };

  if (pnlUsd < 0) {
    next.consecutiveLosses = state.consecutiveLosses + 1;
    if (rule.risk.fire_after_n_losses > 0 && next.consecutiveLosses >= rule.risk.fire_after_n_losses) {
      const until = new Date(
        now.getTime() + rule.risk.pause_hours_after_losses * 3600_000,
      );
      next.pausedUntil = until.toISOString();
      next.consecutiveLosses = 0;
      events.push({
        at: now.toISOString(),
        type: "risk_block",
        ruleId: rule.id,
        message: `Consecutive-loss pause armed until ${next.pausedUntil} (${rule.risk.fire_after_n_losses} losses)`,
        data: { pause_hours: rule.risk.pause_hours_after_losses },
      });
    }
  } else {
    next.consecutiveLosses = 0;
  }

  return { state: next, events };
}
