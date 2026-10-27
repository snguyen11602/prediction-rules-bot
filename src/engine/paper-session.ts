import { enabledRules, loadRulesFile } from "../rules/loader.js";
import type { Rule } from "../rules/schema.js";
import { createAdapters, type PlatformAdapter } from "../platforms/index.js";
import type { EngineEvent, NormalizedMarket, PaperExitReason, PlatformId } from "../types.js";
import {
  closePosition,
  findOpenPosition,
  lastExitAt,
  loadLedger,
  markPosition,
  openPosition,
  openPositions,
  pruneLastPrices,
  riskStateFromLedger,
  saveLedger,
  summarizeLedger,
  withLedgerLock,
  type PaperLedger,
  type PaperPosition,
} from "../ledger/paper.js";
import type { EventSink } from "./events.js";
import { consoleSink } from "./events.js";
import { evaluateExit } from "./exits.js";
import type { PriorPrice } from "./evaluate.js";
import { buyPrice, canTrade, sellPrice, settlementPrice } from "./pricing.js";
import { applyOutcome, defaultRiskState, type RiskState } from "./risk.js";
import {
  evaluateRules,
  fetchMarkets,
  marketKey,
  marketRef,
  papersRule,
  platformsFromRules,
} from "./runner.js";
import { dayKeyLA } from "./clock.js";
import { loadSeries, saveSeries, seriesPathFor } from "./series.js";
import { ArbitrageSchema, arbitrageAsRule } from "../rules/schema.js";
import {
  arbConfig,
  arbScanLimit,
  emitArbSignals,
  finalizeArbGroups,
  findOpportunities,
  openArbGroups,
  quoteEnv,
  slicePerPlatform,
  summarizeQuote,
  unwindArbGroups,
  loadUniverse,
  saveUniverse,
  universePathFor,
  type ArbOpportunity,
} from "./arb-runtime.js";

/**
 * One paper-trading cycle against the ledger. Hypothetical only: this module
 * reads public market data through PlatformAdapter and writes a local JSON file.
 * It never imports or calls any order-placement code.
 *
 *   1. Mark every open position; settle resolved markets at 1/0;
 *      close positions whose rule exit conditions fire.
 *   2. Feed realized PnL into the consecutive-loss pause (persisted per rule).
 *   3. Evaluate entries with risk state rebuilt from the ledger, skipping
 *      markets already held or inside the re-entry cooldown.
 */
export interface PaperCycleOptions {
  rulesPath: string;
  ledgerPath: string;
  demo?: boolean;
  fixturePath?: string;
  limitPerPlatform?: number;
  emit?: EventSink;
  /** Paper every enabled rule, not only `action: paper` rules. */
  paperAll?: boolean;
  now?: Date;
  /** Test hook: inject adapters instead of building them from flags. */
  adapters?: PlatformAdapter[];
}

export interface PaperCycleResult {
  events: EngineEvent[];
  /** Per-market rule positions (arbitrage is reported separately in `arb`). */
  opened: number;
  closed: number;
  realizedPnlUsd: number;
  arb?: {
    opportunities: ArbOpportunity[];
    opened: number;
    closed: number;
    realizedPnlUsd: number;
  };
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function positionRef(p: PaperPosition, yesPrice?: number): NonNullable<EngineEvent["market"]> {
  return {
    platform: p.platform,
    id: p.marketId,
    title: p.title,
    yesPrice: yesPrice ?? (p.side === "yes" ? p.lastMarkPrice ?? p.entryPrice : 1 - (p.lastMarkPrice ?? p.entryPrice)),
    url: p.url,
  };
}

export async function runPaperCycle(opts: PaperCycleOptions): Promise<PaperCycleResult> {
  const emit = opts.emit ?? consoleSink;
  const events: EngineEvent[] = [];
  const push = async (e: EngineEvent) => {
    events.push(e);
    await emit(e);
  };
  const now = opts.now ?? new Date();
  const demo = !!opts.demo;
  const file = await loadRulesFile(opts.rulesPath);
  // Exits use every rule in the file (a disabled rule's open positions still get managed);
  // entries use enabled rules only.
  const allRules = new Map(file.rules.map((r) => [r.id, r]));
  const rules = enabledRules(file);
  // arbCfg gates finding / opening new arbs; open arbs are always managed (see arbCtx).
  const arbCfg = arbConfig(file);
  const arbManageCfg = file.arbitrage ?? ArbitrageSchema.parse({ enabled: false });
  const arbRule = arbitrageAsRule(arbManageCfg);

  return withLedgerLock(opts.ledgerPath, async () => {
    const ledger = await loadLedger(opts.ledgerPath, { demo });
    let opened = 0;
    let closed = 0;
    let realized = 0;
    const arb = { opportunities: [] as ArbOpportunity[], opened: 0, closed: 0, realizedPnlUsd: 0 };

    await push({
      at: now.toISOString(),
      type: "scan_start",
      message: `Paper cycle: ${rules.length} rule(s)${arbCfg ? " + arbitrage" : ""}, ${openPositions(ledger).length} open position(s)${demo ? " [DEMO]" : ""}`,
      data: { rulesPath: opts.rulesPath, ledger: opts.ledgerPath, demo },
    });

    const platforms = new Set<PlatformId>(platformsFromRules(rules));
    if (arbCfg) {
      platforms.add("kalshi");
      platforms.add("polymarket");
    }
    for (const p of openPositions(ledger)) platforms.add(p.platform);

    let adapters: PlatformAdapter[];
    try {
      adapters =
        opts.adapters ??
        createAdapters({ demo, platforms: [...platforms], fixturePath: opts.fixturePath });
    } catch (err) {
      await push({ at: now.toISOString(), type: "adapter_error", message: (err as Error).message });
      return { events, opened, closed, realizedPnlUsd: realized, arb };
    }
    const adapterFor = (id: PlatformId) => adapters.find((a) => a.id === id);

    const limit = opts.limitPerPlatform ?? 80;
    const { markets: fetched, failed } = await fetchMarkets(adapters, arbScanLimit(arbCfg, limit), push);
    // Per-market rules see the usual top `limit` per platform; arbitrage matching sees the wider scan.
    const markets = slicePerPlatform(fetched, limit);
    const listed = new Map(fetched.map((m) => [marketKey(m), m]));
    const lookups = new Map<string, Promise<NormalizedMarket | null>>();
    const getMarket = async (platform: PlatformId, id: string): Promise<NormalizedMarket | null | undefined> => {
      const key = `${platform}:${id}`;
      const hit = listed.get(key);
      if (hit) return hit;
      const adapter = adapterFor(platform);
      if (!adapter?.getMarket || failed.has(platform)) return undefined;
      if (!lookups.has(key)) lookups.set(key, adapter.getMarket(id).catch(() => null));
      return lookups.get(key)!;
    };
    const hasOpenArbs = Object.values(ledger.arbGroups ?? {}).some((g) => g.status === "open");
    const arbCtx =
      arbCfg || hasOpenArbs
        ? { ledger, cfg: arbManageCfg, rule: arbRule, env: quoteEnv(arbManageCfg, adapters, now), now, push, getMarket }
        : undefined;
    // Arbitrage groups are managed as a whole: sell every leg early when that already pays in full.
    if (arbCtx) await unwindArbGroups(arbCtx);

    // ---- 1. Exits / settlement -------------------------------------------------
    for (const pos of openPositions(ledger)) {
      const key = `${pos.platform}:${pos.marketId}`;
      const adapter = adapterFor(pos.platform);
      let market: NormalizedMarket | null | undefined = listed.get(key);
      if (!market && adapter?.getMarket && !failed.has(pos.platform)) {
        try {
          market = await adapter.getMarket(pos.marketId);
        } catch (err) {
          await push({
            at: now.toISOString(),
            type: "adapter_error",
            ruleId: pos.ruleId,
            message: `${pos.platform}: could not refresh ${pos.marketId} (${(err as Error).message}); position left open`,
            market: positionRef(pos),
          });
          continue;
        }
      }
      if (!market) {
        await push({
          at: now.toISOString(),
          type: "info",
          ruleId: pos.ruleId,
          message: `No current data for ${key}; position left open at last mark ${pos.lastMarkPrice?.toFixed(3) ?? "n/a"}`,
          market: positionRef(pos),
        });
        continue;
      }

      // Arbitrage legs are managed as a group, never by a per-market rule's exits.
      const rule = pos.groupId ? undefined : allRules.get(pos.ruleId);
      const settle = settlementPrice(market, pos.side);
      let exit: { price: number; reason: PaperExitReason; detail: string; feeUsd: number } | null = null;

      if (settle != null) {
        exit = {
          price: settle,
          reason: "resolved",
          detail: market.resolvedOutcome
            ? `market resolved ${market.resolvedOutcome.toUpperCase()}`
            : `market settled at YES=${market.settlementYesPrice?.toFixed(3)}`,
          feeUsd: 0, // settlement is not a trade
        };
      } else if (market.status === "resolved") {
        pos.marketStatus = "closed";
        await push({
          at: now.toISOString(),
          type: "info",
          ruleId: pos.ruleId,
          message: `${key} reports resolved without a usable payout; position held. Close it manually with npm run paper:close if needed.`,
          market: marketRef(market),
        });
        continue;
      } else if (!canTrade(market, pos.side, "sell")) {
        // Empty bid for the held side: there is nothing to sell into, so hold.
        // Mark at the mid for reporting only; never treat an empty book as a 0 price.
        const mid = pos.side === "yes" ? market.yesPrice : market.noPrice ?? 1 - market.yesPrice;
        markPosition(pos, mid, now, "open");
        await push({
          at: now.toISOString(),
          type: "info",
          ruleId: pos.ruleId,
          message: `${key}: no bid for ${pos.side.toUpperCase()}; holding (marked at mid ${mid.toFixed(3)}, exits skipped)`,
          market: marketRef(market),
        });
        continue;
      } else if (market.status === "closed") {
        pos.marketStatus = "closed";
        await push({
          at: now.toISOString(),
          type: "info",
          ruleId: pos.ruleId,
          message: `${key} closed, awaiting resolution; position held`,
          market: marketRef(market),
        });
        continue;
      } else {
        const mark = sellPrice(market, pos.side);
        markPosition(pos, mark, now, "open");
        const decision = rule ? evaluateExit(rule.exit, pos, market, mark, now) : null;
        if (decision) {
          const slippage = rule?.paper.slippage ?? 0;
          const price = sellPrice(market, pos.side, slippage);
          const fee =
            rule?.paper.include_fees === false ? 0 : adapter?.estimateTakerFeeUsd?.(pos.contracts, price, market) ?? 0;
          exit = { price, reason: decision.reason, detail: decision.detail, feeUsd: fee };
        }
      }

      if (!exit) continue;
      const pnl = closePosition(ledger, pos, { ...exit, at: now });
      if (!pos.groupId) {
        closed += 1;
        realized += pnl;
      }
      await push({
        at: now.toISOString(),
        type: "paper_exit",
        ruleId: pos.ruleId,
        message:
          `Paper exit ${exit.reason.toUpperCase()} ${pos.side.toUpperCase()} ` +
          `${pos.entryPrice.toFixed(3)} → ${exit.price.toFixed(3)} PnL ${money(pnl)} (${exit.detail})`,
        market: marketRef(market),
        side: pos.side,
        sizeUsd: pos.costUsd,
        data: { positionId: pos.id, reason: exit.reason, pnlUsd: pnl, feeUsd: exit.feeUsd },
      });

      if (rule) {
        const rs = ledger.ruleState[rule.id] ?? { consecutiveLosses: 0 };
        const before: RiskState = {
          ...defaultRiskState(dayKeyLA(now)),
          consecutiveLosses: rs.consecutiveLosses,
          pausedUntil: rs.pausedUntil,
          openPositions: 1,
        };
        const { state: after, events: riskEvents } = applyOutcome(rule, before, pnl, now);
        ledger.ruleState[rule.id] = {
          consecutiveLosses: after.consecutiveLosses,
          pausedUntil: after.pausedUntil,
        };
        for (const e of riskEvents) await push(e);
      }
    }

    // Arbitrage groups whose legs have all settled are scored once, as one trade.
    if (arbCtx) {
      const f = await finalizeArbGroups(arbCtx);
      arb.closed += f.closed;
      arb.realizedPnlUsd += f.realizedPnlUsd;
    }

    // ---- 2. Entries ---------------------------------------------------------------
    if (!opts.paperAll && rules.length > 0 && !rules.some((r) => papersRule(r))) {
      await push({
        at: now.toISOString(),
        type: "info",
        message: "No enabled rules have action: paper — signals will alert only. Use --paper-all to paper every rule.",
      });
    }

    const riskByRule = new Map<string, RiskState>(
      rules.map((r) => [r.id, riskStateFromLedger(ledger, r.id, now)]),
    );
    const history = new Map<string, PriorPrice>(Object.entries(ledger.lastPrices));
    // Price / volume history for unusual-move rules, kept next to the ledger.
    const seriesPath = seriesPathFor(opts.ledgerPath);
    const series = await loadSeries(seriesPath);
    series.record(markets, now);

    const skipMarket = (rule: Rule, market: NormalizedMarket, side: "yes" | "no"): string | null => {
      if (findOpenPosition(ledger, rule.id, market.platform, market.id)) return "already holding";
      const exitedAt = lastExitAt(ledger, rule.id, market.platform, market.id);
      if (exitedAt) {
        const hrs = (now.getTime() - new Date(exitedAt).getTime()) / 3600_000;
        if (hrs < rule.risk.reentry_cooldown_hours) return "re-entry cooldown";
      }
      if (!canTrade(market, side, "buy")) return "no ask";
      const price = buyPrice(market, side, rule.paper.slippage);
      if (!(price > 0 && price < 1)) return "no executable price";
      return null;
    };

    let entrySignals = 0;
    let skipReasons: Record<string, number> = {};
    if (markets.length > 0) {
      const res = await evaluateRules({
        rules,
        markets,
        mode: "paper",
        now,
        push,
        history,
        riskByRule,
        paperAll: opts.paperAll,
        series,
        skipMarket,
        onSignal: async ({ rule, market, side, sizeUsd }) => {
          if (!papersRule(rule, opts.paperAll)) return false;
          const price = buyPrice(market, side, rule.paper.slippage);
          const adapter = adapterFor(market.platform);
          const contracts = adapter?.roundContracts ? adapter.roundContracts(sizeUsd / price) : sizeUsd / price;
          if (!(contracts > 0)) {
            await push({
              at: now.toISOString(),
              type: "info",
              ruleId: rule.id,
              message: `Size $${sizeUsd.toFixed(2)} buys less than one contract at ${price.toFixed(3)}; not filled`,
              market: marketRef(market),
            });
            return false;
          }
          const costUsd = Math.round(contracts * price * 1e6) / 1e6;
          const fee =
            rule.paper.include_fees === false
              ? 0
              : adapter?.estimateTakerFeeUsd?.(contracts, price, market) ?? 0;
          const pos = openPosition(ledger, {
            ruleId: rule.id,
            platform: market.platform,
            marketId: market.id,
            title: market.title,
            url: market.url,
            side,
            price,
            sizeUsd: costUsd,
            feeUsd: fee,
            at: now,
          });
          // Mark at the sell side immediately so the spread shows up as unrealized cost.
          markPosition(pos, sellPrice(market, side), now, "open");
          opened += 1;
          await push({
            at: now.toISOString(),
            type: "paper_fill",
            ruleId: rule.id,
            message: `Paper fill ${side.toUpperCase()} ${pos.contracts.toFixed(2)} @ ${price.toFixed(3)} = $${costUsd.toFixed(2)} (fee $${fee.toFixed(2)})`,
            market: marketRef(market),
            side,
            sizeUsd: costUsd,
            data: { positionId: pos.id, price, contracts: pos.contracts, feeUsd: fee },
          });
          return costUsd;
        },
      });
      entrySignals = res.signals;
      skipReasons = res.skipReasons;
      for (const [k, v] of history) ledger.lastPrices[k] = v;
      pruneLastPrices(ledger, now);
    }
    if (markets.length > 0) await saveSeries(seriesPath, series).catch(() => undefined);

    if (arbCfg && arbCtx && fetched.length > 0) {
      const universePath = universePathFor(opts.ledgerPath);
      const universe = await loadUniverse(universePath);
      const { quotes } = await findOpportunities({
        cfg: arbCfg,
        rulesPath: opts.rulesPath,
        adapters,
        markets: fetched,
        lookup: async (p, id) => (await getMarket(p, id)) ?? null,
        push,
        now,
        universe,
      });
      arb.opportunities = quotes.map((q) => summarizeQuote(q, arbCfg));
      await emitArbSignals(quotes, push, now, { action: arbCfg.action, cfg: arbCfg });
      if (arbCfg.action === "paper") arb.opened += (await openArbGroups(arbCtx, quotes)).opened;
      await saveUniverse(universePath, universe).catch(() => undefined);
    }

    // ---- 3. Summary + persist -----------------------------------------------------
    const { total } = summarizeLedger(ledger);
    await push({
      at: now.toISOString(),
      type: "paper_summary",
      message:
        `Open ${total.open} (exposure ${money(total.exposureUsd)}, unrealized ${money(total.unrealizedPnlUsd)}) | ` +
        `Closed ${total.closed} (${total.wins}W/${total.losses}L, realized ${money(total.realizedPnlUsd)}, fees ${money(total.feesUsd)})`,
      data: { ...total, ledger: opts.ledgerPath },
    });

    await saveLedger(opts.ledgerPath, ledger);

    await push({
      at: new Date().toISOString(),
      type: "scan_end",
      message:
        markets.length === 0
          ? "No markets available (all adapters failed or empty). Open positions were not re-marked. Try --demo."
          : `Done. ${markets.length} markets checked by rules${fetched.length > markets.length ? ` (${fetched.length} fetched for arbitrage)` : ""}, ${entrySignals} entry signal(s), ${opened} opened, ${closed} closed (realized ${money(realized)}).` +
            (arbCfg
              ? ` Arbitrage: ${arb.opportunities.length} found, ${arb.opened} opened, ${arb.closed} closed (${money(arb.realizedPnlUsd)}).`
              : "") +
            (Object.keys(skipReasons).length
              ? ` Skipped: ${Object.entries(skipReasons).map(([k, v]) => `${v} ${k}`).join(", ")}.`
              : ""),
      data: {
        markets: fetched.length,
        signals: entrySignals,
        opened,
        closed,
        realizedPnlUsd: realized,
        skipped: skipReasons,
        arb: { found: arb.opportunities.length, opened: arb.opened, closed: arb.closed, realizedPnlUsd: arb.realizedPnlUsd },
      },
    });

    arb.realizedPnlUsd = Math.round(arb.realizedPnlUsd * 100) / 100;
    return { events, opened, closed, realizedPnlUsd: Math.round(realized * 100) / 100, arb };
  });
}

export type { PaperLedger };
