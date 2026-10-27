import type { Tick } from "./series.js";

/**
 * Flags price moves that are unusual *for that market*: big compared with its
 * own recent volatility, on a volume spike, and not already reversed. That is
 * the footprint informed traders often leave, but so do news, whales and thin
 * books — treat it as a signal to look at, not proof of anything.
 * Pure: works only on our own price/volume snapshots (public data).
 */

export interface UnusualParams {
  /** Measure the move over the last N minutes. */
  window_minutes: number;
  /** Learn "normal" from this much history before the window. */
  lookback_hours: number;
  /** Minimum absolute YES price move (0–1, e.g. 0.05 = 5¢). */
  min_move: number;
  /** Move size in standard deviations of this market's normal moves over the same time span. */
  min_zscore: number;
  /** Volume in the window vs the market's average for that span (0 = don't require volume). */
  min_volume_ratio: number;
  /** Skip if the price has already given back more than this share of the move (0–1). */
  max_retrace: number;
  /** Snapshots needed before the window to judge "normal". */
  min_history_points: number;
  direction: "up" | "down" | "any";
}

export interface UnusualMove {
  direction: "up" | "down";
  from: number;
  to: number;
  /** Signed YES price change over the window. */
  move: number;
  zscore: number;
  /** Undefined when the platform gave no volume. */
  volumeRatio?: number;
  retrace: number;
  windowMinutes: number;
}

export interface UnusualResult {
  move?: UnusualMove;
  /** Why nothing was flagged (for debugging / UI). */
  reason: string;
}

/** Smallest "normal" move we assume for a window, so flat markets don't divide by ~0. */
const SIGMA_FLOOR = 0.005;
/** Latest snapshot must be this fresh to say anything about "now". */
const MAX_STALE_MS = 20 * 60_000;

export function detectUnusualMove(ticks: Tick[], nowMs: number, p: UnusualParams): UnusualResult {
  const winMs = p.window_minutes * 60_000;
  const lookStart = nowMs - p.lookback_hours * 3600_000 - winMs;
  const series = ticks.filter((t) => t.t >= lookStart && t.t <= nowMs).sort((a, b) => a.t - b.t);
  const latest = series.at(-1);
  if (!latest || nowMs - latest.t > MAX_STALE_MS) return { reason: "no recent price" };

  const ws = nowMs - winMs;
  const base = series.filter((t) => t.t <= ws);
  const start = base.at(-1);
  if (!start || base.length < p.min_history_points || ws - base[0].t < winMs) {
    const hrs = base.length ? (ws - base[0].t) / 3600_000 : 0;
    return { reason: `not enough history yet (${hrs.toFixed(1)}h)` };
  }

  const move = latest.p - start.p;
  const abs = Math.abs(move);
  if (abs < p.min_move) return { reason: "move too small" };
  const direction = move > 0 ? "up" : "down";
  if (p.direction !== "any" && p.direction !== direction) return { reason: `move is ${direction}` };

  // How much of the move has already been given back?
  const inWindow = series.filter((t) => t.t > ws);
  const extreme = direction === "up" ? Math.max(...inWindow.map((t) => t.p)) : Math.min(...inWindow.map((t) => t.p));
  const span = Math.abs(extreme - start.p);
  const retrace = span > 0 ? Math.abs(extreme - latest.p) / span : 0;
  if (retrace > p.max_retrace) return { reason: "move already reversing" };

  // This market's normal move over the same time span: the RMS of window-length changes
  // before the window. Measured directly (not scaled from 5-minute ticks) so the normal
  // back-and-forth flicker of a quiet market doesn't look like volatility.
  const sigmaWindow = typicalWindowMove(base, winMs);
  const zscore = abs / Math.max(sigmaWindow, SIGMA_FLOOR);
  if (zscore < p.min_zscore) return { reason: `normal for this market (${zscore.toFixed(1)}σ)` };

  // Volume: platforms give a rolling 24h total. Volume in the window ≈ change in that total
  // plus what rolled off the back (about one average window's worth).
  let volumeRatio: number | undefined;
  if (latest.v != null && start.v != null) {
    const avgPerWindow = (start.v * p.window_minutes) / 1440;
    const inWin = Math.max(0, latest.v - start.v + avgPerWindow);
    volumeRatio = avgPerWindow > 0 ? inWin / avgPerWindow : inWin > 0 ? 99 : 0;
  }
  if (p.min_volume_ratio > 0) {
    if (volumeRatio == null) return { reason: "no volume data" };
    if (volumeRatio < p.min_volume_ratio) return { reason: `no volume spike (${volumeRatio.toFixed(1)}×)` };
  }

  return {
    move: {
      direction,
      from: start.p,
      to: latest.p,
      move,
      zscore: Math.round(zscore * 10) / 10,
      volumeRatio: volumeRatio != null ? Math.round(volumeRatio * 10) / 10 : undefined,
      retrace: Math.round(retrace * 100) / 100,
      windowMinutes: p.window_minutes,
    },
    reason: "unusual",
  };
}

function typicalWindowMove(base: Tick[], winMs: number): number {
  let sum = 0;
  let n = 0;
  let j = 0;
  for (let i = 0; i < base.length; i++) {
    const target = base[i].t - winMs;
    if (target < base[0].t) continue;
    while (j + 1 < base.length && base[j + 1].t <= target) j++;
    const d = base[i].p - base[j].p;
    sum += d * d;
    n++;
  }
  if (n >= 6) return Math.sqrt(sum / n);
  // Short history: fall back to scaling tick-to-tick variance (overstates noisy markets).
  let sq = 0;
  let mins = 0;
  for (let i = 1; i < base.length; i++) {
    const dt = (base[i].t - base[i - 1].t) / 60_000;
    if (dt <= 0) continue;
    sq += (base[i].p - base[i - 1].p) ** 2;
    mins += dt;
  }
  return mins > 0 ? Math.sqrt((sq / mins) * (winMs / 60_000)) : 0;
}

export function describeMove(m: UnusualMove): string {
  const cents = Math.round(Math.abs(m.move) * 1000) / 10;
  const vol = m.volumeRatio != null ? `, volume ${m.volumeRatio}× normal` : "";
  return `unusual ${m.direction === "up" ? "+" : "−"}${cents}¢ in ${m.windowMinutes}m (${m.zscore}σ${vol})`;
}
