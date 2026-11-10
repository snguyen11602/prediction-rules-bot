import { stat } from "node:fs/promises";
import { z } from "zod";
import { downloadLab, loadLab, saveLab, summarizeLab, type LabData, type LabProgress, type LabSummary } from "./data.js";
import { backtest, monteCarlo, pickBets, ruleBlocker, ruleFor, ruleYaml, type LabParams, type LabResult, type McResult } from "./engine.js";

/**
 * The backtest lab behind the dashboard: the dataset on disk (cached in memory), a run endpoint
 * that turns query settings into a backtest + Monte Carlo result, and a background download.
 * Everything here is read-only public history and arithmetic; nothing touches the paper ledger.
 */

const day = /^\d{4}-\d{2}-\d{2}$/;
/** Settings as the page sends them: prices and moves in cents, percentages as whole numbers. */
export const LabQuery = z.object({
  pick: z.enum(["favorite", "underdog", "riser", "faller", "all"]).default("favorite"),
  min: z.coerce.number().min(0).max(100).default(85),
  max: z.coerce.number().min(0).max(100).default(95),
  entry: z.coerce.number().int().min(0).max(24).default(1),
  from: z.coerce.number().int().min(1).max(26).default(12),
  move: z.coerce.number().min(0.5).max(50).default(2),
  spread: z.coerce.number().min(1).max(20).default(5),
  leagues: z.string().max(400).default(""),
  start: z.string().regex(day).optional(),
  end: z.string().regex(day).optional(),
  exec: z.enum(["taker", "maker"]).default("taker"),
  exit: z.enum(["result", "pregame"]).default("result"),
  exitH: z.coerce.number().int().min(0).max(23).default(0),
  stake: z.enum(["flat", "percent"]).default("flat"),
  size: z.coerce.number().min(1).max(100_000).default(25),
  pct: z.coerce.number().min(0.1).max(100).default(2),
  bank: z.coerce.number().min(10).max(10_000_000).default(1000),
  runs: z.coerce.number().int().min(100).max(10_000).default(2000),
  /** Bets in each simulated future; 0 = as many as the backtest made. */
  horizon: z.coerce.number().int().min(0).max(5000).default(0),
  /** "Ruin" = losing this percent of the bankroll. */
  ruin: z.coerce.number().min(5).max(95).default(50),
  seed: z.coerce.number().int().min(0).max(1_000_000_000).default(1),
});
export type LabQueryIn = z.infer<typeof LabQuery>;

export function toParams(q: LabQueryIn): LabParams {
  const lo = Math.min(q.min, q.max) / 100;
  const hi = Math.max(q.min, q.max) / 100;
  return {
    pick: q.pick,
    minPrice: lo,
    maxPrice: hi,
    entryH: q.entry,
    fromH: q.from,
    minMove: q.move / 100,
    maxSpread: q.spread / 100,
    leagues: q.leagues.split(",").map((s) => s.trim()).filter((s) => /^[A-Z0-9]{3,24}$/.test(s)),
    from: q.start ? Date.parse(`${q.start}T00:00:00Z`) : undefined,
    to: q.end ? Date.parse(`${q.end}T23:59:59Z`) : undefined,
    exec: q.exec,
    exit: q.exit,
    exitH: q.exitH,
    stake: q.stake,
    size: q.size,
    pct: q.pct / 100,
    bankroll: q.bank,
  };
}

/** One-sided chance of a result at least this far from zero if the true edge were nothing (normal approximation). */
export function luckChance(t: number): number {
  const x = Math.abs(t) / Math.SQRT2;
  // Abramowitz–Stegun erf approximation; plenty for a two-digit percentage.
  const k = 1 / (1 + 0.3275911 * x);
  const erf = 1 - ((((1.061405429 * k - 1.453152027) * k + 1.421413741) * k - 0.284496736) * k + 0.254829592) * k * Math.exp(-x * x);
  return (1 - erf) / 2;
}

export interface LabRunResponse {
  ok: true;
  stats: LabResult["stats"];
  verdict: string;
  /** Chance of a result this far from zero by luck alone. */
  luck: number;
  /** [game start ms, cumulative profit] through the test, thinned to a few hundred points. */
  equity: Array<[number, number]>;
  byLeague: LabResult["byLeague"];
  byMonth: LabResult["byMonth"];
  byPrice: LabResult["byPrice"];
  /** The latest bets, newest first. */
  trades: Array<{ at: number; side: string; game: string; league: string; price: number; exit: number; won: boolean; stake: number; pnl: number; move?: number }>;
  mc: McResult | null;
  yaml: string | null;
  /** Can the bot trade this test on paper? The strategy it would add, or the reason it can't. */
  paper: { ok: true; id: string; name: string; notes: string[] } | { ok: false; why: string };
  /** Things the reader should know about how to read this run. */
  notes: string[];
}

export function runLab(data: LabData, q: LabQueryIn): LabRunResponse {
  const p = toParams(q);
  const result = backtest(pickBets(data, p), p);
  const n = result.trades.length;
  const step = Math.max(1, Math.ceil(n / 500));
  const equity: Array<[number, number]> = [];
  result.trades.forEach((t, i) => {
    if (i % step === 0 || i === n - 1) equity.push([t.start, Math.round((t.bankroll - p.bankroll) * 100) / 100]);
  });
  const horizon = q.horizon || n;
  // Keep a single run under a few tens of millions of draws.
  const runs = Math.max(100, Math.min(q.runs, Math.floor(20_000_000 / Math.max(1, horizon))));
  const mc = n >= 5 ? monteCarlo(result.trades.map((t) => t.ret), { runs, horizon, stake: p.stake, size: p.size, pct: p.pct, bankroll: p.bankroll, ruinAt: 1 - q.ruin / 100, seed: q.seed }) : null;
  const notes: string[] = [];
  if (p.exec === "maker") notes.push("Limit orders are assumed to fill every time. In practice they fill more often when the price is about to fall, so real results are worse than this.");
  if (p.pick === "all") notes.push("Every side in the price range is bought, so one game can hold two bets that can't both win.");
  if (p.exit === "pregame" && p.exitH >= p.entryH) notes.push("The sell time isn't after the buy time, so every bet is held to the result.");
  const rode = result.trades.filter((t) => t.rode).length;
  if (rode) notes.push(`${rode.toLocaleString("en-US")} of ${n.toLocaleString("en-US")} bets had no usable price at the sell time and were held to the result instead.`);
  if ((p.pick === "riser" || p.pick === "faller") && p.fromH <= p.entryH) notes.push("The earlier price has to be from before the buy time; nothing can match with these two settings.");
  // Leagues picked after seeing which did best flatter a test. Show the same test without the pick.
  if (p.leagues.length && n > 0) {
    const all = backtest(pickBets(data, { ...p, leagues: [] }), p).stats;
    if (all.bets > n) {
      const pct = (x: number) => `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x * 100).toFixed(1)}%`;
      notes.push(`On every league, the same test made ${all.bets.toLocaleString("en-US")} bets for ${pct(all.ret)} per $1 (here: ${pct(result.stats.ret)}). Leagues chosen because they did best in a test usually do worse afterwards.`);
    }
  }
  if (result.stats.bustAt != null) {
    const when = new Date(result.stats.bustAt).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
    notes.push(`With bets this size the bankroll would have run out on ${when}. The test keeps going as if it were topped up, so these totals describe the strategy, not whether the bankroll survives. Smaller bets, or the simulation below, answer that.`);
  }
  return {
    ok: true,
    stats: result.stats,
    verdict: result.verdict,
    luck: luckChance(result.stats.t),
    equity,
    byLeague: result.byLeague,
    byMonth: result.byMonth,
    byPrice: result.byPrice,
    trades: result.trades
      .slice(-250)
      .reverse()
      .map((t) => ({ at: t.start, side: t.side, game: t.game, league: t.series, price: t.price, exit: t.exitValue, won: t.won, stake: Math.round(t.stake * 100) / 100, pnl: Math.round(t.pnl * 100) / 100, move: t.move })),
    mc,
    yaml: ruleYaml(p),
    paper: paperInfo(p),
    notes,
  };
}

function paperInfo(p: LabParams): LabRunResponse["paper"] {
  const made = ruleFor(p);
  if (!made) return { ok: false, why: ruleBlocker(p) ?? "The bot can't paper trade this test." };
  return { ok: true, id: made.rule.id, name: made.rule.name, notes: made.notes };
}

export interface LabUpdateState {
  running: boolean;
  progress?: LabProgress;
  startedAt?: string;
  finishedAt?: string;
  error?: string;
  /** Games added by the last finished update. */
  added?: number;
}

export interface LabService {
  status(): Promise<{ dataset: LabSummary; update: LabUpdateState }>;
  run(query: URLSearchParams): Promise<LabRunResponse | { ok: false; error: string }>;
  /** One run from settings that are already checked; null when there's no game history yet. */
  test(q: LabQueryIn): Promise<LabRunResponse | null>;
  /** Start a background download; false when one is already running. */
  update(): boolean;
}

export function createLabService(file: string, download: typeof downloadLab = downloadLab): LabService {
  let cache: { mtimeMs: number; data: LabData | null } | undefined;
  const state: LabUpdateState = { running: false };
  const load = async (): Promise<LabData | null> => {
    const mtimeMs = await stat(file).then((s) => s.mtimeMs, () => -1);
    if (!cache || cache.mtimeMs !== mtimeMs) cache = { mtimeMs, data: mtimeMs < 0 ? null : await loadLab(file) };
    return cache.data;
  };
  return {
    async status() {
      return { dataset: summarizeLab(await load()), update: { ...state } };
    },
    async run(query) {
      const data = await load();
      if (!data?.markets.length) return { ok: false, error: "no game history yet" };
      const parsed = LabQuery.safeParse(Object.fromEntries(query));
      if (!parsed.success) return { ok: false, error: `bad setting: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}` };
      return runLab(data, parsed.data);
    },
    async test(q) {
      const data = await load();
      return data?.markets.length ? runLab(data, q) : null;
    },
    update() {
      if (state.running) return false;
      state.running = true;
      state.error = undefined;
      state.startedAt = new Date().toISOString();
      state.progress = { stage: "games", done: 0, total: 1 };
      void (async () => {
        try {
          const existing = await load();
          const before = summarizeLab(existing).games;
          const data = await download({ existing, onProgress: (p) => (state.progress = p) });
          await saveLab(file, data);
          state.added = summarizeLab(data).games - before;
        } catch (err) {
          state.error = err instanceof Error ? err.message : String(err);
        } finally {
          state.running = false;
          state.finishedAt = new Date().toISOString();
        }
      })();
      return true;
    },
  };
}
