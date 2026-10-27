import { enabledRules, loadRulesFile } from "../rules/loader.js";
import type { Rule } from "../rules/schema.js";
import { createAdapters, type PlatformAdapter } from "../platforms/index.js";
import type { EngineEvent, NormalizedMarket, PlatformId, SignalSide } from "../types.js";
import { dayKeyLA } from "./clock.js";
import { evaluateEntry, type PriorPrice } from "./evaluate.js";
import { checkEntryRisk, defaultRiskState, type RiskState } from "./risk.js";
import type { EventSink } from "./events.js";
import { consoleSink } from "./events.js";

export interface SignalArgs {
  rule: Rule;
  market: NormalizedMarket;
  side: SignalSide;
  sizeUsd: number;
  reason: string;
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
  /**
   * Called for each entry signal. In paper mode, return the USD exposure actually
   * added (or `true` for the signalled size) when a position was opened; anything
   * else means nothing was filled and no risk capacity is consumed.
   */
  onSignal?: (args: SignalArgs) => Promise<SignalResult> | SignalResult;
}

export type SignalResult = number | boolean | void;

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
  onSignal?: RunnerOptions["onSignal"];
}

/** Which rules get hypothetical fills in paper mode. Live is never executed. */
export function papersRule(rule: Rule, paperAll = false): boolean {
  return paperAll || rule.action === "paper" || rule.action === "live";
}

export async function evaluateRules(
  opts: EvaluateOptions,
): Promise<{ signals: number; suppressed: number; skipped: number; skipReasons: Record<string, number> }> {
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

  for (const rule of rules) {
    if (!riskByRule.has(rule.id)) riskByRule.set(rule.id, defaultRiskState(dk));
    const riskState = riskByRule.get(rule.id)!;
    if (riskState.dayKey !== dk) {
      riskState.dayKey = dk;
      riskState.dayPnlUsd = 0;
    }
    const fills = opts.mode === "paper" && papersRule(rule, opts.paperAll);
    const action = fills ? "paper" : "alert";

    for (const market of markets) {
      const key = marketKey(market);
      const match = evaluateEntry(rule, market, priors.get(key), now);
      if (!match) continue;

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
          continue;
        }
      }

      await push({
        at: now.toISOString(),
        type: "market_match",
        ruleId: rule.id,
        message: match.reason,
        market: marketRef(market),
        side: match.side,
      });

      const gate = checkEntryRisk(rule, riskState, now);
      if (!gate.ok) {
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
      await push({
        at: now.toISOString(),
        type: "entry_signal",
        ruleId: rule.id,
        message: `${action.toUpperCase()} ${match.side.toUpperCase()} ~$${sizeUsd.toFixed(2)} — ${market.title}`,
        market: marketRef(market),
        side: match.side,
        sizeUsd,
        data: {
          action,
          rule_action: rule.action,
          position_size_fraction: rule.risk.position_size_fraction,
          reason: match.reason,
        },
      });
      signals += 1;

      const filled = opts.onSignal
        ? await opts.onSignal({ rule, market, side: match.side, sizeUsd, reason: match.reason })
        : undefined;

      // Only confirmed (hypothetical) fills consume risk capacity. Alert-only runs
      // never open positions, so they must not count toward max_open_positions.
      if (fills && (filled === true || typeof filled === "number")) {
        riskState.openPositions += 1;
        if (riskState.openExposureUsd != null) {
          riskState.openExposureUsd += typeof filled === "number" ? filled : sizeUsd;
        }
      }
    }
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
  return { signals, suppressed, skipped, skipReasons };
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
      platforms: platformsFromRules(rules),
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

  const { markets } = await fetchMarkets(adapters, opts.limitPerPlatform ?? 80, push);

  if (markets.length === 0) {
    await push({
      at: new Date().toISOString(),
      type: "scan_end",
      message: "No markets available (all adapters failed or empty). Try --demo.",
    });
    return events;
  }

  const { signals, suppressed } = await evaluateRules({
    rules,
    markets,
    mode: opts.mode ?? "alert",
    now,
    push,
    history: opts.priceHistory ?? new Map<string, PriorPrice>(),
    riskByRule: opts.riskByRule ?? new Map<string, RiskState>(),
    lastMatched: opts.lastMatched,
    onSignal: opts.onSignal,
  });

  await push({
    at: new Date().toISOString(),
    type: "scan_end",
    message:
      `Done. ${markets.length} markets scanned, ${signals} entry signal(s).` +
      (suppressed ? ` ${suppressed} repeat match(es) suppressed.` : ""),
    data: { markets: markets.length, signals, suppressed },
  });

  return events;
}
