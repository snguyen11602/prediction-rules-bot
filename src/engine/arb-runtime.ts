import type { ArbitrageConfig, Rule, RulesFile } from "../rules/schema.js";
import { arbitrageAsRule } from "../rules/schema.js";
import type { EventGroup, PlatformAdapter } from "../platforms/types.js";
import type { EngineEvent, NormalizedMarket, PlatformId } from "../types.js";
import {
  closePosition,
  markPosition,
  openPosition,
  riskStateFromLedger,
  type ArbGroupRecord,
  type PaperLedger,
  type PaperPosition,
} from "../ledger/paper.js";
import {
  bestQuotes,
  discoverBaskets,
  kindLabel,
  loadPairsFile,
  pairsFilePath,
  unwindProceeds,
  type ArbQuote,
  type Discovery,
  type QuoteEnv,
} from "./arb.js";
import { sellPrice } from "./pricing.js";
import { applyOutcome, checkEntryRisk, defaultRiskState, positionSizeUsd, type RiskState } from "./risk.js";
import { dayKeyLA } from "./clock.js";
import { randomUUID } from "node:crypto";

/**
 * Runs the arbitrage strategy inside scan / watch / paper. Uses only the
 * read-only PlatformAdapter interface and the local paper ledger.
 */

type Push = (e: EngineEvent) => Promise<void>;
type Lookup = (platform: PlatformId, id: string) => Promise<NormalizedMarket | null>;

export interface ArbOpportunity {
  key: string;
  kind: ArbQuote["basket"]["kind"];
  kindLabel: string;
  title: string;
  matchedBy: string;
  score?: number;
  edge: number;
  profitUsd: number;
  costUsd: number;
  sets: number;
  hoursToResolve?: number;
  annualizedReturn?: number;
  legs: Array<{ platform: PlatformId; marketId: string; title: string; side: string; price: number; url?: string }>;
}

export function arbConfig(file: RulesFile): ArbitrageConfig | undefined {
  return file.arbitrage?.enabled ? file.arbitrage : undefined;
}

/** Markets to fetch per platform so cross-platform matching has enough overlap. */
export function arbScanLimit(cfg: ArbitrageConfig | undefined, limit: number): number {
  return cfg?.cross_platform.enabled ? Math.max(limit, cfg.cross_platform.scan_limit) : limit;
}

/** Keep the first `limit` markets per platform (listing order) for the per-market rules. */
export function slicePerPlatform(markets: NormalizedMarket[], limit: number): NormalizedMarket[] {
  const counts = new Map<PlatformId, number>();
  return markets.filter((m) => {
    const n = counts.get(m.platform) ?? 0;
    counts.set(m.platform, n + 1);
    return n < limit;
  });
}

export function quoteEnv(cfg: ArbitrageConfig, adapters: PlatformAdapter[], now: Date): QuoteEnv {
  const adapterFor = (id: PlatformId) => adapters.find((a) => a.id === id);
  return {
    slippage: cfg.paper.slippage,
    includeFees: cfg.paper.include_fees,
    now,
    feeFor: (platform, contracts, price) => adapterFor(platform)?.estimateTakerFeeUsd?.(contracts, price) ?? 0,
    roundSets: (platforms, sets) => {
      let s = Math.floor(sets * 100 + 1e-9) / 100;
      for (const p of new Set(platforms)) {
        const a = adapterFor(p);
        if (a?.roundContracts) s = Math.min(s, a.roundContracts(sets));
      }
      return s;
    },
  };
}

function summarize(q: ArbQuote): ArbOpportunity {
  return {
    key: q.basket.key,
    kind: q.basket.kind,
    kindLabel: kindLabel(q.basket.kind),
    title: q.basket.title,
    matchedBy: q.basket.matchedBy,
    score: q.basket.score,
    edge: Math.round(q.edge * 10000) / 10000,
    profitUsd: q.profitUsd,
    costUsd: q.costUsd,
    sets: q.sets,
    hoursToResolve: q.hoursToResolve != null ? Math.round(q.hoursToResolve) : undefined,
    annualizedReturn: q.annualizedReturn != null ? Math.round(q.annualizedReturn * 1000) / 1000 : undefined,
    legs: q.legs.map((l) => ({
      platform: l.market.platform,
      marketId: l.market.id,
      title: l.market.title,
      side: l.side,
      price: Math.round(l.price * 10000) / 10000,
      url: l.market.url,
    })),
  };
}

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

/** Find arbitrage opportunities that clear min_edge and the time limit. */
export async function findOpportunities(args: {
  cfg: ArbitrageConfig;
  rulesPath: string;
  adapters: PlatformAdapter[];
  markets: NormalizedMarket[];
  lookup: Lookup;
  push: Push;
  now: Date;
}): Promise<{ quotes: ArbQuote[]; discovery: Discovery; checked: number }> {
  const { adapters, push, now } = args;
  let cfg = args.cfg;
  let pairs = { confirmed: [], blocked: [] } as Awaited<ReturnType<typeof loadPairsFile>>;
  try {
    pairs = await loadPairsFile(pairsFilePath(args.rulesPath, cfg));
  } catch (err) {
    await push({
      at: now.toISOString(),
      type: "adapter_error",
      ruleId: "arbitrage",
      message: `Arbitrage pairs file is invalid (${(err as Error).message}); cross-platform arbitrage skipped this cycle`,
    });
    if (cfg.cross_platform.enabled) cfg = { ...cfg, cross_platform: { ...cfg.cross_platform, enabled: false } };
  }

  const eventGroups: EventGroup[] = [];
  if (cfg.same_platform.enabled) {
    for (const a of adapters) {
      if (!a.listEventGroups) continue;
      try {
        eventGroups.push(...(await a.listEventGroups({ limit: cfg.same_platform.scan_events })));
      } catch (err) {
        await push({
          at: now.toISOString(),
          type: "adapter_error",
          ruleId: "arbitrage",
          message: `${a.id}: could not load events for same-site arbitrage (${(err as Error).message})`,
          data: { platform: a.id },
        });
      }
    }
  }

  const discovery = await discoverBaskets({ cfg, pairs, markets: args.markets, lookup: args.lookup, eventGroups });
  const env = quoteEnv(cfg, adapters, now);
  const size = positionSizeUsd(arbitrageAsRule(cfg).risk);
  const quotes = bestQuotes(discovery.baskets, size, env).filter(
    (q) => q.edge >= cfg.min_edge && (q.hoursToResolve == null || q.hoursToResolve <= cfg.max_hours_to_resolve),
  );
  const checked = new Set(discovery.baskets.map((b) => b.key)).size;
  await push({
    at: now.toISOString(),
    type: "info",
    ruleId: "arbitrage",
    message:
      `Arbitrage: checked ${checked} set(s) — ${discovery.candidates.length} auto-matched pair(s), ` +
      `${pairs.confirmed.length} confirmed pair(s), ${eventGroups.filter((g) => g.mutuallyExclusive).length} exclusive event(s); ` +
      `${quotes.length} opportunit${quotes.length === 1 ? "y" : "ies"} ≥ ${(cfg.min_edge * 100).toFixed(1)}¢ per $1`,
  });
  return { quotes, discovery, checked };
}

export async function emitArbSignals(
  quotes: ArbQuote[],
  push: Push,
  now: Date,
  opts: { action: "alert" | "paper"; lastMatched?: Set<string> },
): Promise<number> {
  let emitted = 0;
  const current = new Set(quotes.map((q) => `arb|${q.basket.key}`));
  for (const q of quotes) {
    const k = `arb|${q.basket.key}`;
    if (opts.lastMatched?.has(k)) continue;
    const s = summarize(q);
    const legs = q.legs.map((l) => `${l.side.toUpperCase()} ${l.market.platform} @ ${(l.price * 100).toFixed(1)}¢`).join(" + ");
    await push({
      at: now.toISOString(),
      type: "arb_signal",
      ruleId: "arbitrage",
      message:
        `${opts.action === "paper" ? "PAPER" : "ALERT"} ARB ${(q.edge * 100).toFixed(1)}¢ per $1 ` +
        `(${money(q.profitUsd)} on ${money(q.costUsd + q.feesUsd)}) — ${q.basket.title} [${legs}]` +
        (q.basket.matchedBy === "auto" ? " (auto-matched: check both questions are the same)" : ""),
      market: {
        platform: q.legs[0].market.platform,
        id: q.legs[0].market.id,
        title: q.basket.title,
        yesPrice: q.legs[0].market.yesPrice,
        url: q.basket.url ?? q.legs[0].market.url,
      },
      sizeUsd: q.costUsd,
      data: { ...s, action: opts.action },
    });
    emitted += 1;
  }
  if (opts.lastMatched) {
    for (const k of [...opts.lastMatched]) if (k.startsWith("arb|") && !current.has(k)) opts.lastMatched.delete(k);
    for (const k of current) opts.lastMatched.add(k);
  }
  return emitted;
}

// ---------------------------------------------------------------- paper -----

interface PaperCtx {
  ledger: PaperLedger;
  cfg: ArbitrageConfig;
  rule: Rule;
  env: QuoteEnv;
  now: Date;
  push: Push;
  getMarket: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null | undefined>;
}

function groupsOf(ledger: PaperLedger): Record<string, ArbGroupRecord> {
  ledger.arbGroups ??= {};
  return ledger.arbGroups;
}

function legsOf(ledger: PaperLedger, g: ArbGroupRecord): PaperPosition[] {
  const ids = new Set(g.legIds);
  return ledger.positions.filter((p) => ids.has(p.id));
}

/** Before per-leg exits: sell all legs of a group when that already returns the full guaranteed payout. */
export async function unwindArbGroups(ctx: PaperCtx): Promise<{ closedLegs: number }> {
  if (!ctx.cfg.unwind_early) return { closedLegs: 0 };
  let closedLegs = 0;
  for (const g of Object.values(groupsOf(ctx.ledger))) {
    if (g.status !== "open") continue;
    const legs = legsOf(ctx.ledger, g);
    if (legs.length !== g.legIds.length || legs.some((l) => l.status !== "open")) continue;
    const markets = await Promise.all(legs.map((l) => ctx.getMarket(l.platform, l.marketId)));
    if (markets.some((m) => !m || (m.status ?? "open") !== "open")) continue;
    const u = unwindProceeds(
      legs.map((l, i) => ({ market: markets[i]!, side: l.side, contracts: l.contracts })),
      ctx.env,
    );
    const payout = g.sets * g.payoutPerSet;
    if (!u || u.proceedsUsd + 1e-9 < payout) continue;
    for (let i = 0; i < legs.length; i++) {
      const pnl = closePosition(ctx.ledger, legs[i], {
        price: u.prices[i],
        feeUsd: u.fees[i],
        at: ctx.now,
        reason: "arb_unwind",
        detail: `sold early: all legs together ${money(u.proceedsUsd)} ≥ ${money(payout)} payout`,
      });
      closedLegs += 1;
      await ctx.push({
        at: ctx.now.toISOString(),
        type: "paper_exit",
        ruleId: ctx.rule.id,
        message: `Arb leg sold early ${legs[i].side.toUpperCase()} ${legs[i].entryPrice.toFixed(3)} → ${u.prices[i].toFixed(3)} PnL ${money(pnl)}`,
        market: { platform: legs[i].platform, id: legs[i].marketId, title: legs[i].title, yesPrice: markets[i]!.yesPrice, url: legs[i].url },
        side: legs[i].side,
        data: { positionId: legs[i].id, groupId: g.id, reason: "arb_unwind", pnlUsd: pnl },
      });
    }
  }
  return { closedLegs };
}

/** After per-leg exits: close groups whose legs have all settled, and score them once. */
export async function finalizeArbGroups(ctx: PaperCtx): Promise<{ closed: number; realizedPnlUsd: number }> {
  let closed = 0;
  let realized = 0;
  for (const g of Object.values(groupsOf(ctx.ledger))) {
    if (g.status !== "open") continue;
    const legs = legsOf(ctx.ledger, g);
    if (legs.some((l) => l.status === "open")) continue;
    const pnl = Math.round(legs.reduce((a, l) => a + (l.realizedPnlUsd ?? 0), 0) * 100) / 100;
    const reasons = new Set(legs.map((l) => l.exitReason));
    g.status = "closed";
    g.closedAt = legs.map((l) => l.exitAt ?? ctx.now.toISOString()).sort().at(-1);
    g.realizedPnlUsd = pnl;
    g.closeReason = reasons.size === 1 ? ([...reasons][0] as ArbGroupRecord["closeReason"]) : "mixed";
    closed += 1;
    realized += pnl;
    await ctx.push({
      at: ctx.now.toISOString(),
      type: "arb_close",
      ruleId: ctx.rule.id,
      message:
        `Arb closed (${g.closeReason === "arb_unwind" ? "sold early" : g.closeReason}) PnL ${money(pnl)} ` +
        `vs ${money(g.expectedProfitUsd)} expected — ${g.title}` +
        (pnl < 0 ? " — LOSS: the legs did not settle as a hedge; check the questions really matched" : ""),
      data: { groupId: g.id, pnlUsd: pnl, expectedProfitUsd: g.expectedProfitUsd, kind: g.kind, reason: g.closeReason },
    });
    const rs = ctx.ledger.ruleState[ctx.rule.id] ?? { consecutiveLosses: 0 };
    const before: RiskState = {
      ...defaultRiskState(dayKeyLA(ctx.now)),
      consecutiveLosses: rs.consecutiveLosses,
      pausedUntil: rs.pausedUntil,
      openPositions: 1,
    };
    const { state: after, events } = applyOutcome(ctx.rule, before, pnl, ctx.now);
    ctx.ledger.ruleState[ctx.rule.id] = { consecutiveLosses: after.consecutiveLosses, pausedUntil: after.pausedUntil };
    for (const e of events) await ctx.push(e);
  }
  return { closed, realizedPnlUsd: Math.round(realized * 100) / 100 };
}

/** Open paper arbs, best edge first, through the shared risk gate. */
export async function openArbGroups(ctx: PaperCtx, quotes: ArbQuote[]): Promise<{ opened: number }> {
  const groups = groupsOf(ctx.ledger);
  const risk = riskStateFromLedger(ctx.ledger, ctx.rule.id, ctx.now);
  let opened = 0;
  for (const q of quotes) {
    if (Object.values(groups).some((g) => g.status === "open" && g.key === q.basket.key)) continue;
    const lastClose = Object.values(groups)
      .filter((g) => g.key === q.basket.key && g.closedAt)
      .map((g) => g.closedAt!)
      .sort()
      .at(-1);
    if (lastClose && (ctx.now.getTime() - new Date(lastClose).getTime()) / 3600_000 < ctx.rule.risk.reentry_cooldown_hours) continue;

    const gate = checkEntryRisk(ctx.rule, risk, ctx.now);
    if (!gate.ok) {
      await ctx.push({ at: ctx.now.toISOString(), type: "risk_block", ruleId: ctx.rule.id, message: `${gate.reason} — ${q.basket.title}` });
      break; // the same gate blocks every remaining opportunity this cycle
    }
    const id = randomUUID();
    const legIds: string[] = [];
    for (const l of q.legs) {
      const pos = openPosition(ctx.ledger, {
        ruleId: ctx.rule.id,
        platform: l.market.platform,
        marketId: l.market.id,
        title: l.market.title,
        url: l.market.url,
        side: l.side,
        price: l.price,
        sizeUsd: Math.round(q.sets * l.price * 1e6) / 1e6,
        feeUsd: l.feeUsd,
        at: ctx.now,
        groupId: id,
      });
      markPosition(pos, sellPrice(l.market, l.side), ctx.now, "open");
      legIds.push(pos.id);
    }
    groups[id] = {
      id,
      ruleId: ctx.rule.id,
      key: q.basket.key,
      kind: q.basket.kind,
      title: q.basket.title,
      matchedBy: q.basket.matchedBy,
      score: q.basket.score,
      status: "open",
      openedAt: ctx.now.toISOString(),
      sets: q.sets,
      payoutPerSet: q.basket.payoutPerSet,
      costUsd: q.costUsd,
      entryFeesUsd: q.feesUsd,
      expectedProfitUsd: q.profitUsd,
      edge: q.edge,
      legIds,
    };
    risk.openPositions += 1;
    risk.openExposureUsd = (risk.openExposureUsd ?? 0) + q.costUsd;
    opened += 1;
    await ctx.push({
      at: ctx.now.toISOString(),
      type: "arb_open",
      ruleId: ctx.rule.id,
      message:
        `Paper arb opened: ${q.sets} set(s), cost ${money(q.costUsd)} + fees ${money(q.feesUsd)}, ` +
        `locks in ${money(q.profitUsd)} if it settles as expected — ${q.basket.title}`,
      sizeUsd: q.costUsd,
      data: { groupId: id, ...summarize(q) },
    });
  }
  return { opened };
}

export { summarize as summarizeQuote };
