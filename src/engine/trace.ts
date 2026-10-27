/**
 * Decision trace: every check the engine makes, in order, with the real numbers.
 * The same checks drive the decision (evaluate / risk) and the dashboard's
 * "How the bot decides" view, so what you see is what the bot did.
 */

export type Stage = "filters" | "signal" | "position" | "risk" | "fill";

export const STAGES: Stage[] = ["filters", "signal", "position", "risk", "fill"];

export interface Check {
  stage: Stage;
  /** Short name, e.g. "Price band". */
  name: string;
  ok: boolean;
  /** Human-readable numbers, e.g. "YES 42¢ is within 15–85¢". */
  detail: string;
}

export function cents(p: number | undefined): string {
  if (p == null || !Number.isFinite(p)) return "—";
  const c = Math.round(p * 1000) / 10;
  return `${Number.isInteger(c) ? c : c.toFixed(1)}¢`;
}

export function usd(n: number | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: n !== 0 && Math.abs(n) < 100 ? 2 : 0 })}`;
}

export function hours(h: number | undefined): string {
  if (h == null || !Number.isFinite(h)) return "—";
  if (Math.abs(h) < 48) return `${Math.round(h)}h`;
  return `${Math.round(h / 24)}d`;
}

/** First failing check, if any. */
export function firstFailure(checks: Check[]): Check | undefined {
  return checks.find((c) => !c.ok);
}

/** Furthest stage a trace got through (the stage of its first failure, or "fill" if none failed). */
export function stageReached(checks: Check[]): { stage: Stage; passed: boolean } {
  const fail = firstFailure(checks);
  if (fail) return { stage: fail.stage, passed: false };
  return { stage: checks.at(-1)?.stage ?? "filters", passed: true };
}

export interface FunnelRow {
  ruleId: string;
  name: string;
  action: "paper" | "alert";
  scanned: number;
  passedFilters: number;
  signals: number;
  passedPosition: number;
  passedRisk: number;
  /** Paper: positions opened. Alert: alerts sent. */
  done: number;
  /** Most common first-failing checks, e.g. [{ name: "Price band", stage: "filters", count: 120 }]. */
  topReasons: Array<{ stage: Stage; name: string; count: number }>;
}

export interface TraceMarket {
  platform: string;
  id: string;
  title: string;
  yesPrice: number;
  url?: string;
}

export interface Decision {
  ruleId: string;
  market: TraceMarket;
  outcome: "traded" | "alerted" | "risk_blocked" | "skipped" | "not_filled" | "near_miss";
  checks: Check[];
}

export interface ScanSample {
  ruleId: string;
  title: string;
  platform: string;
  /** Furthest stage reached; `passed` = got all the way through. */
  stage: Stage;
  passed: boolean;
  fail?: string;
}

export interface ScanTrace {
  at: string;
  markets: number;
  rules: FunnelRow[];
  decisions: Decision[];
  sample: ScanSample[];
}
