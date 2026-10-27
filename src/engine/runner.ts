import { enabledRules, loadRulesFile } from "../rules/loader.js";
import type { Rule } from "../rules/schema.js";
import { createAdapters, type PlatformAdapter } from "../platforms/index.js";
import type { EngineEvent, NormalizedMarket, PlatformId } from "../types.js";
import { evaluateEntry, type PriorPrice } from "./evaluate.js";
import { checkEntryRisk, defaultRiskState, type RiskState } from "./risk.js";
import type { EventSink } from "./events.js";
import { consoleSink } from "./events.js";

export interface RunnerOptions {
  rulesPath: string;
  demo?: boolean;
  limitPerPlatform?: number;
  mode?: "alert" | "paper";
  emit?: EventSink;
  /** Prior prices keyed by `${platform}:${id}` for move conditions. */
  priceHistory?: Map<string, PriorPrice>;
  /** Per-rule risk state (paper/watch). */
  riskByRule?: Map<string, RiskState>;
  onSignal?: (args: {
    rule: Rule;
    market: NormalizedMarket;
    side: "yes" | "no";
    sizeUsd: number;
    reason: string;
  }) => Promise<void> | void;
}

function dayKeyLA(d = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
}

function platformsFromRules(rules: Rule[]): PlatformId[] {
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
  const dk = dayKeyLA(now);

  await push({
    at: now.toISOString(),
    type: "scan_start",
    message: `Scanning ${rules.length} rule(s)${opts.demo ? " [DEMO]" : ""}`,
    data: { rulesPath: opts.rulesPath, demo: !!opts.demo },
  });

  const platforms = platformsFromRules(rules);
  let adapters: PlatformAdapter[];
  try {
    adapters = createAdapters({ demo: opts.demo, platforms });
  } catch (err) {
    await push({
      at: new Date().toISOString(),
      type: "adapter_error",
      message: (err as Error).message,
    });
    return events;
  }

  const markets: NormalizedMarket[] = [];
  for (const adapter of adapters) {
    try {
      const batch = await adapter.listMarkets({
        limit: opts.limitPerPlatform ?? 80,
      });
      markets.push(...batch);
      await push({
        at: new Date().toISOString(),
        type: "info",
        message: `${adapter.id}: fetched ${batch.length} markets`,
      });
    } catch (err) {
      await push({
        at: new Date().toISOString(),
        type: "adapter_error",
        message: `${adapter.id}: ${(err as Error).message}. Tip: re-run with --demo for fixtures.`,
        data: { platform: adapter.id },
      });
    }
  }

  if (markets.length === 0) {
    await push({
      at: new Date().toISOString(),
      type: "scan_end",
      message: "No markets available (all adapters failed or empty). Try --demo.",
    });
    return events;
  }

  const history = opts.priceHistory ?? new Map<string, PriorPrice>();
  const riskMap = opts.riskByRule ?? new Map<string, RiskState>();

  let signals = 0;
  for (const rule of rules) {
    if (!riskMap.has(rule.id)) riskMap.set(rule.id, defaultRiskState(dk));
    const riskState = riskMap.get(rule.id)!;
    if (riskState.dayKey !== dk) {
      riskState.dayKey = dk;
      riskState.dayPnlUsd = 0;
    }

    for (const market of markets) {
      const key = `${market.platform}:${market.id}`;
      const prior = history.get(key);
      const match = evaluateEntry(rule, market, prior, now);
      history.set(key, { yesPrice: market.yesPrice, at: now.toISOString() });
      if (!match) continue;

      await push({
        at: now.toISOString(),
        type: "market_match",
        ruleId: rule.id,
        message: match.reason,
        market: {
          platform: market.platform,
          id: market.id,
          title: market.title,
          yesPrice: market.yesPrice,
          url: market.url,
        },
        side: match.side,
      });

      const gate = checkEntryRisk(rule, riskState, now);
      if (!gate.ok) {
        await push({
          at: now.toISOString(),
          type: "risk_block",
          ruleId: rule.id,
          message: gate.reason ?? "risk blocked",
          market: {
            platform: market.platform,
            id: market.id,
            title: market.title,
            yesPrice: market.yesPrice,
            url: market.url,
          },
        });
        continue;
      }

      const sizeUsd = gate.sizeUsd ?? 0;
      const effectiveAction =
        opts.mode === "paper" ? "paper" : rule.action === "live" ? "alert" : rule.action;

      await push({
        at: now.toISOString(),
        type: "entry_signal",
        ruleId: rule.id,
        message: `${effectiveAction.toUpperCase()} ${match.side.toUpperCase()} ~$${sizeUsd.toFixed(2)} — ${market.title}`,
        market: {
          platform: market.platform,
          id: market.id,
          title: market.title,
          yesPrice: market.yesPrice,
          url: market.url,
        },
        side: match.side,
        sizeUsd,
        data: {
          action: effectiveAction,
          position_size_fraction: rule.risk.position_size_fraction,
          reason: match.reason,
        },
      });
      signals += 1;

      if (opts.onSignal) {
        await opts.onSignal({
          rule,
          market,
          side: match.side,
          sizeUsd,
          reason: match.reason,
        });
      }

      // Count as open for risk within this scan session when papering
      if (opts.mode === "paper" || rule.action === "paper") {
        riskState.openPositions += 1;
      }
    }
  }

  await push({
    at: new Date().toISOString(),
    type: "scan_end",
    message: `Done. ${markets.length} markets scanned, ${signals} entry signal(s).`,
    data: { markets: markets.length, signals },
  });

  return events;
}
