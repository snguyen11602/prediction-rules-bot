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
import { buyPrice, sellPrice, settlementPrice } from "./pricing.js";
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
  opened: number;
  closed: number;
  realizedPnlUsd: number;
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

  return withLedgerLock(opts.ledgerPath, async () => {
    const ledger = await loadLedger(opts.ledgerPath, { demo });
    let opened = 0;
    let closed = 0;
    let realized = 0;

    await push({
      at: now.toISOString(),
      type: "scan_start",
      message: `Paper cycle: ${rules.length} rule(s), ${openPositions(ledger).length} open position(s)${demo ? " [DEMO]" : ""}`,
      data: { rulesPath: opts.rulesPath, ledger: opts.ledgerPath, demo },
    });

    const platforms = new Set<PlatformId>(platformsFromRules(rules));
    for (const p of openPositions(ledger)) platforms.add(p.platform);

    let adapters: PlatformAdapter[];
    try {
      adapters =
        opts.adapters ??
        createAdapters({ demo, platforms: [...platforms], fixturePath: opts.fixturePath });
    } catch (err) {
      await push({ at: now.toISOString(), type: "adapter_error", message: (err as Error).message });
      return { events, opened, closed, realizedPnlUsd: realized };
    }
    const adapterFor = (id: PlatformId) => adapters.find((a) => a.id === id);

    const { markets, failed } = await fetchMarkets(adapters, opts.limitPerPlatform ?? 80, push);
    const listed = new Map(markets.map((m) => [marketKey(m), m]));

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

      const rule = allRules.get(pos.ruleId);
      const settle = settlementPrice(market, pos.side);
      let exit: { price: number; reason: PaperExitReason; detail: string; feeUsd: number } | null = null;

      if (settle != null) {
        exit = {
          price: settle,
          reason: "resolved",
          detail: `market resolved ${market.resolvedOutcome?.toUpperCase()}`,
          feeUsd: 0, // settlement is not a trade
        };
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
            rule?.paper.include_fees === false ? 0 : adapter?.estimateTakerFeeUsd?.(pos.contracts, price) ?? 0;
          exit = { price, reason: decision.reason, detail: decision.detail, feeUsd: fee };
        }
      }

      if (!exit) continue;
      const pnl = closePosition(ledger, pos, { ...exit, at: now });
      closed += 1;
      realized += pnl;
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

    const skipMarket = (rule: Rule, market: NormalizedMarket, side: "yes" | "no"): string | null => {
      if (findOpenPosition(ledger, rule.id, market.platform, market.id)) return "already holding";
      const exitedAt = lastExitAt(ledger, rule.id, market.platform, market.id);
      if (exitedAt) {
        const hrs = (now.getTime() - new Date(exitedAt).getTime()) / 3600_000;
        if (hrs < rule.risk.reentry_cooldown_hours) return "re-entry cooldown";
      }
      const price = buyPrice(market, side, rule.paper.slippage);
      if (!(price > 0 && price < 1)) return "no executable price";
      return null;
    };

    let entrySignals = 0;
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
        skipMarket,
        onSignal: async ({ rule, market, side, sizeUsd }) => {
          if (!papersRule(rule, opts.paperAll)) return false;
          const price = buyPrice(market, side, rule.paper.slippage);
          const contracts = sizeUsd / price;
          const fee =
            rule.paper.include_fees === false
              ? 0
              : adapterFor(market.platform)?.estimateTakerFeeUsd?.(contracts, price) ?? 0;
          const pos = openPosition(ledger, {
            ruleId: rule.id,
            platform: market.platform,
            marketId: market.id,
            title: market.title,
            url: market.url,
            side,
            price,
            sizeUsd,
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
            message: `Paper fill ${side.toUpperCase()} ${pos.contracts.toFixed(2)} @ ${price.toFixed(3)} = $${sizeUsd.toFixed(2)} (fee $${fee.toFixed(2)})`,
            market: marketRef(market),
            side,
            sizeUsd,
            data: { positionId: pos.id, price, contracts: pos.contracts, feeUsd: fee },
          });
          return true;
        },
      });
      entrySignals = res.signals;
      for (const [k, v] of history) ledger.lastPrices[k] = v;
      pruneLastPrices(ledger, now);
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
          : `Done. ${markets.length} markets scanned, ${entrySignals} entry signal(s), ${opened} opened, ${closed} closed (realized ${money(realized)}).`,
      data: { markets: markets.length, signals: entrySignals, opened, closed, realizedPnlUsd: realized },
    });

    return { events, opened, closed, realizedPnlUsd: Math.round(realized * 100) / 100 };
  });
}

export type { PaperLedger };
