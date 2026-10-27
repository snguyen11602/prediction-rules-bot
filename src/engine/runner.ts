import { enabledRules, loadRulesFile } from "../rules/loader.js";
import type { Rule } from "../rules/schema.js";
import { createAdapters, type PlatformAdapter } from "../platforms/index.js";
import type { EngineEvent, NormalizedMarket, PlatformId, SignalSide } from "../types.js";
import { dayKeyLA } from "./clock.js";
import { traceEntry, type PriorPrice } from "./evaluate.js";
import { stageReached, type Check, type Decision, type FunnelRow, type ScanSample, type ScanTrace } from "./trace.js";
import { SeriesStore } from "./series.js";
import { checkEntryRisk, defaultRiskState, type RiskState } from "./risk.js";
import type { EventSink } from "./events.js";
import { consoleSink } from "./events.js";
import { arbConfig, arbScanLimit, emitArbSignals, findOpportunities, slicePerPlatform, type ArbUniverse } from "./arb-runtime.js";

export interface SignalArgs {
  rule: Rule;
  market: NormalizedMarket;
  side: SignalSide;
  sizeUsd: number;
  reason: string;
  /** Every check that led here (filters → signal → position → risk), for the trade's story. */
  checks: Check[];
}

export interface RunnerOptions {
  rulesPath: string;
  demo?: boolean;
  /** Demo only: alternate fixture file. */
  fixturePath?: string;
  limitPerPlatform?: number;
  mode?: "alert" | "paper";
  emit?: EventSink;
  /** Prior prices keyed by `${platform}:${id}` for move conditions. */
  priceHistory?: Map<string, PriorPrice>;
  /** Per-rule risk state (paper/watch). */
  riskByRule?: Map<string, RiskState>;
  /**
   * Edge-triggered alerts (watch): matches that were already reported on the
   * previous scan are suppressed until they stop matching and match again.
   */
  lastMatched?: Set<string>;
  /** Watch: keep the arbitrage event cache between polls. */
  arbUniverse?: ArbUniverse;
  /** Watch: rolling price / volume history for unusual-move rules. */
  series?: SeriesStore;
  /**
   * Called for each entry signal. In paper mode, return the USD exposure actually
   * added (or `true` for the signalled size) when a position was opened; anything
   * else means nothing was filled and no risk capacity is consumed.
   */
  onSignal?: (args: SignalArgs) => Promise<SignalResult> | SignalResult;
}

/** Paper fills can also report the fill as a trace check. */
export type SignalResult = number | boolean | void | { exposureUsd: number; fill?: Check };

export function marketKey(m: Pick<NormalizedMarket, "platform" | "id">): string {
  return `${m.platform}:${m.id}`;
}

export function marketRef(market: NormalizedMarket): NonNullable<EngineEvent["market"]> {
  return {
    platform: market.platform,
    id: market.id,
    title: market.title,
    yesPrice: market.yesPrice,
    url: market.url,
  };
}

export function platformsFromRules(rules: Rule[]): PlatformId[] {
  const set = new Set<PlatformId>();
  for (const r of rules) {
    if (r.filters.platforms?.length) {
      for (const p of r.filters.platforms) set.add(p);
    } else {
      set.add("kalshi");
      set.add("polymarket");
    }
  }
  return [...set];
}

function describeError(err: unknown): string {
  const e = err as Error & { cause?: { code?: string; message?: string } };
  const cause = e.cause?.code ?? e.cause?.message;
  return cause && !e.message.includes(cause) ? `${e.message} (${cause})` : e.message;
}

/** Fetch markets from every adapter; one failing adapter never stops the others. */
export async function fetchMarkets(
  adapters: PlatformAdapter[],
  limit: number,
  push: (e: EngineEvent) => Promise<void>,
): Promise<{ markets: NormalizedMarket[]; failed: Set<PlatformId> }> {
  const markets: NormalizedMarket[] = [];
  const failed = new Set<PlatformId>();
  for (const adapter of adapters) {
    try {
      const batch = await adapter.listMarkets({ limit });
      markets.push(...batch);
      await push({
        at: new Date().toISOString(),
        type: "info",
        message: `${adapter.id}: fetched ${batch.length} markets`,
      });
    } catch (err) {
      failed.add(adapter.id);
      await push({
        at: new Date().toISOString(),
        type: "adapter_error",
        message: `${adapter.id}: ${describeError(err)}. Tip: re-run with --demo for fixtures.`,
        data: { platform: adapter.id },
      });
    }
  }
  return { markets, failed };
}

export interface EvaluateOptions {
  rules: Rule[];
  markets: NormalizedMarket[];
  mode: "alert" | "paper";
  now: Date;
  push: (e: EngineEvent) => Promise<void>;
  history: Map<string, PriorPrice>;
  riskByRule: Map<string, RiskState>;
  /** Paper mode: fill every rule, not only `action: paper` (and `live`) rules. */
  paperAll?: boolean;
  /** Paper rules only: return a reason to skip this market (already held, cooldown…). */
  skipMarket?: (rule: Rule, market: NormalizedMarket, side: SignalSide) => string | null;
  lastMatched?: Set<string>;
  /** Price / volume history (already including this scan's snapshot). */
  series?: SeriesStore;
  onSignal?: RunnerOptions["onSignal"];
}

/** Which rules get hypothetical fills in paper mode. Live is never executed. */
export function papersRule(rule: Rule, paperAll = false): boolean {
  return paperAll || rule.action === "paper" || rule.action === "live";
}

export async function evaluateRules(
  opts: EvaluateOptions,
): Promise<{ signals: number; suppressed: number; skipped: number; skipReasons: Record<string, number>; trace: ScanTrace }> {
  const { rules, markets, now, push, history, riskByRule } = opts;
  const dk = dayKeyLA(now);
  // Snapshot priors first so every rule compares against the previous scan,
  // not against a price another rule just wrote this scan.
  const priors = new Map<string, PriorPrice | undefined>();
  for (const m of markets) priors.set(marketKey(m), history.get(marketKey(m)));

  const matchedNow = new Set<string>();
  let signals = 0;
  let suppressed = 0;
  let skipped = 0;
  const skipReasons: Record<string, number> = {};
  const funnel: FunnelRow[] = [];
  const decisions: Decision[] = [];
  const allSamples: ScanSample[] = [];
  const ref = (m: NormalizedMarket) => ({ platform: m.platform, id: m.id, title: m.title, yesPrice: m.yesPrice, url: m.url });

  for (const rule of rules) {
    if (!riskByRule.has(rule.id)) riskByRule.set(rule.id, defaultRiskState(dk));
    const riskState = riskByRule.get(rule.id)!;
    if (riskState.dayKey !== dk) {
      riskState.dayKey = dk;
      riskState.dayPnlUsd = 0;
    }
    const fills = opts.mode === "paper" && papersRule(rule, opts.paperAll);
    const action = fills ? "paper" : "alert";
    const row: FunnelRow = {
      ruleId: rule.id, name: rule.name, action, scanned: 0, passedFilters: 0, signals: 0,
      passedPosition: 0, passedRisk: 0, done: 0, topReasons: [],
    };
    funnel.push(row);
    const reasonCounts = new Map<string, { stage: Check["stage"]; name: string; count: number }>();
    let nearMisses = 0;
    const note = (checks: Check[]) => {
      const r = stageReached(checks);
      const fail = checks.find((c) => !c.ok);
      if (fail) {
        const k = `${fail.stage}|${fail.name}`;
        const prev = reasonCounts.get(k) ?? { stage: fail.stage, name: fail.name, count: 0 };
        prev.count += 1;
        reasonCounts.set(k, prev);
      }
      return { ...r, fail };
    };

    for (const market of markets) {
      const key = marketKey(market);
      row.scanned += 1;
      const t = traceEntry(rule, market, priors.get(key), now, { series: opts.series?.get(key) });
      const checks = [...t.checks];
      const match = t.match;
      const filtersOk = checks.every((c) => c.stage !== "filters" || c.ok);
      if (filtersOk) row.passedFilters += 1;
      const sample = (stage = note(checks)) =>
        allSamples.push({ ruleId: rule.id, title: market.title, platform: market.platform, stage: stage.stage, passed: stage.passed, fail: stage.fail?.detail });
      if (!match) {
        sample();
        if (filtersOk && nearMisses < 3) {
          nearMisses += 1;
          decisions.push({ ruleId: rule.id, market: ref(market), outcome: "near_miss", checks });
        }
        continue;
      }
      row.signals += 1;

      const edgeKey = `${rule.id}|${key}`;
      matchedNow.add(edgeKey);
      if (opts.lastMatched?.has(edgeKey)) {
        suppressed += 1;
        continue;
      }

      if (fills && opts.skipMarket) {
        const why = opts.skipMarket(rule, market, match.side);
        if (why) {
          skipped += 1;
          skipReasons[why] = (skipReasons[why] ?? 0) + 1;
          checks.push({ stage: "position", name: "Position", ok: false, detail: why });
          sample();
          decisions.push({ ruleId: rule.id, market: ref(market), outcome: "skipped", checks });
          continue;
        }
        checks.push({ stage: "position", name: "Position", ok: true, detail: "not already holding, no re-entry cool-down, ask available" });
      }
      row.passedPosition += 1;

      await push({
        at: now.toISOString(),
        type: "market_match",
        ruleId: rule.id,
        message: match.reason,
        market: marketRef(market),
        side: match.side,
      });

      const gate = checkEntryRisk(rule, riskState, now);
      checks.push(...gate.checks);
      if (!gate.ok) {
        sample();
        decisions.push({ ruleId: rule.id, market: ref(market), outcome: "risk_blocked", checks });
        await push({
          at: now.toISOString(),
          type: "risk_block",
          ruleId: rule.id,
          message: gate.reason ?? "risk blocked",
          market: marketRef(market),
        });
        continue;
      }

      const sizeUsd = gate.sizeUsd ?? 0;
      row.passedRisk += 1;
      await push({
        at: now.toISOString(),
        type: "entry_signal",
        ruleId: rule.id,
        message:
          `${action.toUpperCase()} ${match.side.toUpperCase()} ~$${sizeUsd.toFixed(2)} — ${market.title}` +
          (match.unusual ? ` (${match.reason})` : ""),
        market: marketRef(market),
        side: match.side,
        sizeUsd,
        data: {
          action,
          rule_action: rule.action,
          position_size_fraction: rule.risk.position_size_fraction,
          reason: match.reason,
          ...(match.unusual ? { unusual: match.unusual } : {}),
        },
      });
      signals += 1;

      const filled = opts.onSignal
        ? await opts.onSignal({ rule, market, side: match.side, sizeUsd, reason: match.reason, checks: [...checks] })
        : undefined;
      const exposure =
        typeof filled === "number" ? filled : typeof filled === "object" && filled ? filled.exposureUsd : filled === true ? sizeUsd : undefined;

      // Only confirmed (hypothetical) fills consume risk capacity. Alert-only runs
      // never open positions, so they must not count toward max_open_positions.
      if (fills && exposure != null) {
        riskState.openPositions += 1;
        if (riskState.openExposureUsd != null) riskState.openExposureUsd += exposure;
        if (typeof filled === "object" && filled?.fill) checks.push(filled.fill);
        row.done += 1;
        decisions.push({ ruleId: rule.id, market: ref(market), outcome: "traded", checks });
      } else if (!fills) {
        checks.push({ stage: "fill", name: "Alert", ok: true, detail: `alert sent: ${match.side.toUpperCase()} looks interesting (alert-only rule, no trade)` });
        row.done += 1;
        decisions.push({ ruleId: rule.id, market: ref(market), outcome: "alerted", checks });
      } else {
        checks.push({ stage: "fill", name: "Fill", ok: false, detail: "not filled (size buys less than one contract)" });
        decisions.push({ ruleId: rule.id, market: ref(market), outcome: "not_filled", checks });
      }
      sample();
    }
    row.topReasons = [...reasonCounts.values()].sort((a, b) => b.count - a.count).slice(0, 4);
  }

  for (const m of markets) history.set(marketKey(m), { yesPrice: m.yesPrice, at: now.toISOString() });
  if (opts.lastMatched) {
    // Only forget matches for markets we actually saw this scan. A market missing
    // because of an adapter error or listing churn keeps its state, so it doesn't
    // re-alert the moment it reappears.
    const seen = new Set(markets.map(marketKey));
    for (const k of [...opts.lastMatched]) {
      if (seen.has(k.slice(k.indexOf("|") + 1)) && !matchedNow.has(k)) opts.lastMatched.delete(k);
    }
    for (const k of matchedNow) opts.lastMatched.add(k);
  }
  // A readable sample for the dashboard's replay: everything that got far, plus an even spread of the rest.
  const indexed = allSamples.map((x, i) => ({ x, i }));
  const far = indexed.filter(({ x }) => x.passed || x.stage !== "filters").slice(0, 40);
  const rest = indexed.filter(({ x }) => !(x.passed || x.stage !== "filters"));
  const step = Math.max(1, Math.ceil(rest.length / Math.max(1, 80 - far.length)));
  const sample = [...far, ...rest.filter((_, i) => i % step === 0)]
    .sort((a, b) => a.i - b.i) // keep scan order
    .slice(0, 80)
    .map(({ x }) => x);
  const trace: ScanTrace = { at: now.toISOString(), markets: markets.length, rules: funnel, decisions, sample };
  return { signals, suppressed, skipped, skipReasons, trace };
}

export async function runScan(opts: RunnerOptions): Promise<EngineEvent[]> {
  const emit = opts.emit ?? consoleSink;
  const events: EngineEvent[] = [];
  const push = async (e: EngineEvent) => {
    events.push(e);
    await emit(e);
  };

  const file = await loadRulesFile(opts.rulesPath);
  const rules = enabledRules(file);
  const now = new Date();
  const arbCfg = arbConfig(file);

  await push({
    at: now.toISOString(),
    type: "scan_start",
    message: `Scanning ${rules.length} rule(s)${opts.demo ? " [DEMO]" : ""}`,
    data: { rulesPath: opts.rulesPath, demo: !!opts.demo },
  });

  let adapters: PlatformAdapter[];
  try {
    adapters = createAdapters({
      demo: opts.demo,
      platforms: arbCfg ? ["kalshi", "polymarket"] : platformsFromRules(rules),
      fixturePath: opts.fixturePath,
    });
  } catch (err) {
    await push({
      at: new Date().toISOString(),
      type: "adapter_error",
      message: (err as Error).message,
    });
    return events;
  }

  const limit = opts.limitPerPlatform ?? 80;
  const { markets: fetched } = await fetchMarkets(adapters, arbScanLimit(arbCfg, limit), push);
  const markets = slicePerPlatform(fetched, limit);

  if (markets.length === 0) {
    await push({
      at: new Date().toISOString(),
      type: "scan_end",
      message: "No markets available (all adapters failed or empty). Try --demo.",
    });
    return events;
  }

  opts.series?.record(markets, now);
  const { signals, suppressed } = await evaluateRules({
    rules,
    markets,
    mode: opts.mode ?? "alert",
    now,
    push,
    history: opts.priceHistory ?? new Map<string, PriorPrice>(),
    riskByRule: opts.riskByRule ?? new Map<string, RiskState>(),
    lastMatched: opts.lastMatched,
    series: opts.series,
    onSignal: opts.onSignal,
  });

  let arbFound = 0;
  if (arbCfg) {
    const { quotes, complete } = await findOpportunities({
      cfg: arbCfg,
      rulesPath: opts.rulesPath,
      adapters,
      universe: opts.arbUniverse,
      markets: fetched,
      lookup: async (platform, id) => {
        const a = adapters.find((x) => x.id === platform);
        return a?.getMarket ? a.getMarket(id).catch(() => null) : null;
      },
      push,
      now,
    });
    arbFound = quotes.length;
    // scan / watch never trade: arbitrage opportunities are alerts here.
    await emitArbSignals(quotes, push, now, { action: "alert", cfg: arbCfg, lastMatched: opts.lastMatched, complete });
  }

  await push({
    at: new Date().toISOString(),
    type: "scan_end",
    message:
      `Done. ${markets.length} markets checked by rules${fetched.length > markets.length ? ` (${fetched.length} fetched for arbitrage)` : ""}, ${signals} entry signal(s).` +
      (arbCfg ? ` ${arbFound} arbitrage opportunit${arbFound === 1 ? "y" : "ies"}.` : "") +
      (suppressed ? ` ${suppressed} repeat match(es) suppressed.` : ""),
    data: { markets: fetched.length, signals, suppressed, arb: arbFound },
  });

  return events;
}
