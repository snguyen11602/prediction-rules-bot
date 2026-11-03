import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runPaperCycle } from "../engine/paper-session.js";
import { loadLedger } from "../ledger/paper.js";
import type { Rule } from "../rules/schema.js";
import { diagnose, type BlockCounts, type Diagnosis } from "../league/diagnose.js";
import { openByRule, statsFromTrades, tradesByRule, type StrategyStats } from "../league/metrics.js";
import type { PlatformId } from "../types.js";
import { loadHistory, type HistorySet } from "./history.js";
import { ReplayAdapter } from "./replay.js";

/**
 * Backtest: replay recorded prices hour by hour through the normal paper engine (same rules,
 * same checks, same fees), then score each strategy on the whole window and on the held-out
 * last part. Nothing here touches your real paper ledger, and nothing places orders.
 */

export interface BacktestOptions {
  rules: Rule[];
  /** Folder for the replay ledger (wiped at the start of each run). */
  workDir: string;
  cacheDir: string;
  days: number;
  stepMinutes: number;
  testShare: number;
  perPlatform: number;
  minTrades: number;
  platforms?: PlatformId[];
  now?: Date;
  /** Test hook / reuse: skip loading. */
  history?: HistorySet;
  log?: (m: string) => void;
}

export interface StrategyResult {
  all: StrategyStats;
  test: StrategyStats;
  blocks: BlockCounts;
  diagnosis: Diagnosis;
}

export interface BacktestResult {
  from: string;
  to: string;
  testFrom: string;
  stepMinutes: number;
  steps: number;
  seconds: number;
  markets: Record<string, number>;
  ledgerPath: string;
  results: Map<string, StrategyResult>;
  notes: string[];
}

/**
 * Hourly prices can't see a 15-minute move. Rules that only look at very recent moves are
 * compared hour to hour in a backtest instead of never firing at all.
 */
export function forBacktest(rule: Rule, stepMinutes: number): Rule {
  const minAge = Math.ceil(stepMinutes * 1.5);
  const e = rule.entry;
  const entry = e.max_prior_age_minutes != null && e.max_prior_age_minutes < minAge ? { ...e, max_prior_age_minutes: minAge } : e;
  return { ...rule, entry, enabled: true, action: "paper" };
}

export async function runBacktest(o: BacktestOptions): Promise<BacktestResult> {
  const started = Date.now();
  const now = o.now ?? new Date();
  const stepMs = o.stepMinutes * 60_000;
  const to = new Date(Math.floor(now.getTime() / stepMs) * stepMs);
  const from = new Date(to.getTime() - o.days * 86_400_000);
  const testFrom = new Date(to.getTime() - Math.round(o.testShare * o.days * 24) * 3600_000);
  const platforms = o.platforms ?? ["kalshi", "polymarket_us"];
  const notes: string[] = [];

  const history =
    o.history ??
    (await loadHistory({ from, to, perPlatform: o.perPlatform, platforms, cacheDir: o.cacheDir, log: o.log }));
  const markets: Record<string, number> = {};
  for (const h of history.markets) markets[h.market.platform] = (markets[h.market.platform] ?? 0) + 1;

  await rm(o.workDir, { recursive: true, force: true });
  await mkdir(o.workDir, { recursive: true });
  const rulesPath = path.join(o.workDir, "rules.json");
  const ledgerPath = path.join(o.workDir, "ledger.json");
  const rules = o.rules.map((r) => forBacktest(r, o.stepMinutes));
  await writeFile(rulesPath, JSON.stringify({ version: 1, rules }, null, 1));
  if (rules.some((r, i) => r.entry.max_prior_age_minutes !== o.rules[i].entry.max_prior_age_minutes)) {
    notes.push(`Prices are checked every ${o.stepMinutes} minutes, so quick-move rules compare hour to hour here.`);
  }
  if (rules.some((r) => r.filters.min_liquidity_usd != null) && markets.polymarket_us) {
    notes.push("Polymarket US history has no order-book depth, so rules with a liquidity filter only trade Kalshi here.");
  }

  let clock = from;
  const adapters = platforms
    .filter((p) => p === "kalshi" || p === "polymarket_us")
    .map((p) => new ReplayAdapter(p, history.markets, () => clock, Math.max(2 * 3600, o.stepMinutes * 120)));
  const blocks = new Map<string, BlockCounts>(rules.map((r) => [r.id, { checks: 0, signals: 0, blocked: {} }]));
  const limit = Math.max(...Object.values(markets), 1);

  let steps = 0;
  const total = Math.floor((to.getTime() - from.getTime()) / stepMs);
  for (let t = from.getTime(); t <= to.getTime(); t += stepMs) {
    clock = new Date(t);
    const res = await runPaperCycle({
      rulesPath,
      ledgerPath,
      now: clock,
      adapters,
      limitPerPlatform: limit,
      paperAll: true,
      emit: async () => undefined,
    });
    for (const row of res.trace?.rules ?? []) {
      const b = blocks.get(row.ruleId);
      if (!b) continue;
      b.checks += row.scanned;
      b.signals += row.signals;
      for (const r of row.topReasons) b.blocked[r.name] = (b.blocked[r.name] ?? 0) + r.count;
    }
    steps += 1;
    if (o.log && steps % 48 === 0) o.log(`  replayed ${Math.round((steps / total) * 100)}% (${clock.toISOString().slice(0, 16).replace("T", " ")})`);
  }

  const ledger = await loadLedger(ledgerPath, { demo: false });
  const trades = tradesByRule(ledger);
  const open = openByRule(ledger);
  const results = new Map<string, StrategyResult>();
  const testIso = testFrom.toISOString();
  for (const r of rules) {
    const mine = trades.get(r.id) ?? [];
    const o2 = open.get(r.id);
    const opts = { bankrollUsd: r.risk.bankroll_usd, minTrades: o.minTrades };
    const all = statsFromTrades(mine, { ...opts, open: o2?.open, openPnlUsd: o2?.pnl });
    const test = statsFromTrades(
      mine.filter((t) => t.enteredAt >= testIso),
      { ...opts, minTrades: Math.max(1, Math.ceil(o.minTrades / 2)) },
    );
    const b = blocks.get(r.id)!;
    results.set(r.id, { all, test, blocks: b, diagnosis: diagnose(all, { minTrades: o.minTrades, blocks: b, test, now }) });
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    testFrom: testIso,
    stepMinutes: o.stepMinutes,
    steps,
    seconds: Math.round((Date.now() - started) / 1000),
    markets,
    ledgerPath,
    results,
    notes,
  };
}
