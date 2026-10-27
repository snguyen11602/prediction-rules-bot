import type { Rule, RiskConfig } from "../rules/schema.js";
import type { EngineEvent, PaperFill } from "../types.js";

export interface RiskState {
  consecutiveLosses: number;
  pausedUntil?: string;
  openPositions: number;
  /** YYYY-MM-DD in America/Los_Angeles-ish local date string from runner. */
  dayKey: string;
  dayPnlUsd: number;
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

export interface RiskCheckResult {
  ok: boolean;
  reason?: string;
  sizeUsd?: number;
}

/**
 * Gate new entries: consecutive-loss pause, open-position cap, daily loss cap.
 */
export function checkEntryRisk(
  rule: Rule,
  state: RiskState,
  now = new Date(),
): RiskCheckResult {
  const risk = rule.risk;
  if (state.pausedUntil && new Date(state.pausedUntil).getTime() > now.getTime()) {
    return {
      ok: false,
      reason: `paused until ${state.pausedUntil} after ${risk.fire_after_n_losses} consecutive losses`,
    };
  }
  if (state.openPositions >= risk.max_open_positions) {
    return {
      ok: false,
      reason: `max open positions (${risk.max_open_positions}) reached`,
    };
  }
  if (
    risk.daily_loss_cap_usd != null &&
    state.dayPnlUsd <= -Math.abs(risk.daily_loss_cap_usd)
  ) {
    return {
      ok: false,
      reason: `daily loss cap $${risk.daily_loss_cap_usd} hit (pnl=${state.dayPnlUsd.toFixed(2)})`,
    };
  }
  return { ok: true, sizeUsd: positionSizeUsd(risk) };
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
    if (next.consecutiveLosses >= rule.risk.fire_after_n_losses) {
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

export function summarizeFillsForRisk(fills: PaperFill[], dayKey: string): Partial<RiskState> {
  const dayFills = fills.filter((f) => f.at.slice(0, 10) === dayKey);
  // Paper fills are openings only in this starter — PnL tracked separately when exits land.
  return {
    openPositions: fills.length,
    dayKey,
    dayPnlUsd: 0,
    consecutiveLosses: 0,
  };
}
