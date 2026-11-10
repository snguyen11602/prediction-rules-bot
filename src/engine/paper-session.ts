import { enabledRules, loadRulesFile } from "../rules/loader.js";
import type { Rule } from "../rules/schema.js";
import { createAdapters, type PlatformAdapter } from "../platforms/index.js";
import type { EngineEvent, NormalizedMarket, PaperExitReason, PlatformId } from "../types.js";
import {
  closePosition,
  findOpenPosition,
  lastExitAt,
  loadLedger,
  resetLedger,
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
import { evaluateExit, EXIT_MAX_SPREAD, isLossExit, STOP_CONFIRM_SEC } from "./exits.js";
import type { PriorPrice } from "./evaluate.js";
import { buyPrice, canTrade, sellPrice, settlementPrice } from "./pricing.js";
import { applyOutcome, defaultRiskState, type RiskState } from "./risk.js";
import {
  evaluateRules,
  fetchMarkets,
  leaguesWanted,
  marketKey,
  marketRef,
  marketsForRules,
  papersRule,
  platformsFromRules,
} from "./runner.js";
import { dayKeyLA } from "./clock.js";
import { cents, type ScanTrace } from "./trace.js";
import { loadSeries, saveSeries, seriesPathFor } from "./series.js";
import { loadHourly } from "./pregame.js";
import { loadSharp, sharpPathFor, type SharpDeps } from "../sharp/runtime.js";
import { backfillStarts, finalizeClosings, noteClosing, startTracking } from "./closing.js";
import { ARB_RULE_ID, ArbitrageSchema, arbitrageAsRule, copyAsRule, COPY_RULE_ID, PARLAY_RULE_ID } from "../rules/schema.js";
import { checkEntryRisk } from "./risk.js";
import type { Check } from "./trace.js";
import {
  copyView as buildCopyView,
  defaultCopyDeps,
  enterCopies,
  leaderSold,
  pollCopy,
  runParlays,
  saveCopy,
  type CopyCtx,
  type CopyDeps,
  type CopyPoll,
  type CopyView,
} from "./copy-runtime.js";
import { loadPairsFile, pairsFilePath } from "./arb.js";
import { copyStatePathFor } from "./copy.js";
import { settleParlays } from "./parlays.js";
import { parseUsRace } from "./exact-pairs.js";
import { kalshiMatchCode } from "../platforms/kalshi.js";
import { controlsPathFor, isStopped, loadControls } from "./controls.js";
import { houseNames, leaguePathFor, leagueRules, loadLeague, MEMBER_PREFIX, upgradeLeague } from "../league/league.js";
import { labRules, loadStrategies, strategiesPathFor } from "../lab/strategies.js";
import {
  arbConfig,
  arbScanLimit,
  emitArbSignals,
  finalizeArbGroups,
  findOpportunities,
  openArbGroups,
  quoteEnv,
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
  /** Wrap the adapters this cycle uses (fast mode swaps in live streamed quotes). */
  wrapAdapters?: (adapters: PlatformAdapter[]) => PlatformAdapter[];
  /**
   * A quick in-between check (fast mode): exits and paper entries only, on cached listings with
   * live quotes. Alert-only rules, arbitrage discovery and price history are left to the full
   * checks, and "price moved since the last check" still means since the last FULL check.
   */
  fastTick?: boolean;
  /** Test hook: public lookups for copy trading (default: the live Polymarket APIs). */
  copyDeps?: CopyDeps;
  /** Test hook: the odds-service key and fetch for sharp lines (default: ODDS_API_KEY, real fetch; off in demo). */
  sharpDeps?: Pick<SharpDeps, "key" | "fetchImpl">;
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
  /** What the scan looked at and why it did / didn't trade (for the dashboard). */
  trace?: ScanTrace;
  arbTrace?: import("./arb-runtime.js").ArbTrace;
  /** Copy trading: who's followed and what happened to their latest bets. */
  copy?: CopyView;
  /** Paper parlays made / settled this cycle. */
  parlays?: { opened: number; closed: number; realizedPnlUsd: number };
}

/**
 * The same market, another market in the same event (Kalshi tickers are `<event>-<outcome>`, so
 * "PSG by 3.5" and "PSG by 4.5" are one game), or another Kalshi market on the same match (a spread,
 * a total and a team total of one game).
 */
/** Bid / ask of the side held (NO's bid is 1 − YES ask). */
function heldQuotes(m: NormalizedMarket, side: "yes" | "no"): { bid?: number; ask?: number } {
  return side === "yes" ? { bid: m.yesBid, ask: m.yesAsk } : { bid: m.yesAsk != null ? 1 - m.yesAsk : undefined, ask: m.yesBid != null ? 1 - m.yesBid : undefined };
}

export function sameGame(p: Pick<PaperPosition, "platform" | "marketId" | "eventKey">, m: Pick<NormalizedMarket, "platform" | "id" | "eventId" | "raw">): boolean {
  if (p.platform !== m.platform) return false;
  if (p.marketId === m.id) return true;
  // Same game or race, another market (Polymarket US: the other team, or the other party's candidate).
  const ek = eventKeyOf(m);
  if (ek && p.eventKey === ek) return true;
  if (m.platform !== "kalshi") return false;
  if (m.eventId && p.marketId.startsWith(`${m.eventId}-`)) return true;
  // One match, many market types: KXUCLSPREAD-26NOV03VILPSG-…, KXUCLTOTAL-26NOV03VILPSG-…,
  // KXUCLTEAMTOTAL-26NOV03VILPSG-… all share the match code (date + teams).
  const a = kalshiMatchCode(p.marketId);
  return !!a && a === kalshiMatchCode(m.id);
}

export { kalshiMatchCode };

const US_GAME_SLUG = /^[a-z]+-([a-z0-9]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2})/;

/**
 * The game or race a market belongs to: Kalshi's match code (date + teams) or event; on Polymarket
 * US the game in the slug (moneyline, spread and total share it) or the election race (both
 * parties' markets share it).
 */
export function eventKeyOf(m: Pick<NormalizedMarket, "platform" | "id" | "eventId" | "raw">): string | undefined {
  if (m.platform === "kalshi") {
    const code = kalshiMatchCode(m.id);
    return code ? `kalshi:${code}` : m.eventId ? `kalshi:${m.eventId}` : undefined;
  }
  const slug = (m.raw as { slug?: string } | undefined)?.slug;
  if (!slug) return undefined;
  const race = parseUsRace(slug);
  if (race) return `${m.platform}:${race.office}-${race.state}-${race.district ?? ""}-${race.year}`;
  const g = US_GAME_SLUG.exec(slug);
  return g ? `${m.platform}:${g[1]}` : undefined;
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
  // Copy positions are managed by the copy strategy's exits even after it's switched off.
  const copyCfg = file.copy_trading;
  const copyRule = copyCfg ? copyAsRule(copyCfg) : undefined;
  if (copyRule) allRules.set(copyRule.id, copyRule);
  // League strategies (bot-made, named like traders) paper-trade next to your own rules.
  // Retired members stay in allRules (disabled) so their open trades are still managed.
  // A broken league file or member is reported and skipped; your own rules keep trading.
  const strategyProblems: string[] = [];
  let leagueList: Rule[] = [];
  try {
    const league = await loadLeague(leaguePathFor(opts.ledgerPath));
    upgradeLeague(league, houseNames(file));
    leagueList = leagueRules(league, file.league, (m, err) =>
      strategyProblems.push(`League strategy ${m.name ?? m.id} skipped: ${err.message.slice(0, 160)}`),
    );
  } catch (err) {
    strategyProblems.push(`League strategies skipped: ${(err as Error).message}`);
  }
  for (const r of leagueList) if (!allRules.has(r.id)) allRules.set(r.id, r);
  // Lab strategies: tests added to paper trading from the backtest lab. Same treatment as the
  // league's: a removed one stays known (disabled) so its open bets settle under its name, and a
  // broken file or strategy is reported and skipped.
  let labList: Rule[] = [];
  try {
    labList = labRules(await loadStrategies(strategiesPathFor(opts.ledgerPath)), new Set(allRules.keys()), (s, why) =>
      strategyProblems.push(`Lab strategy ${s.name ?? s.id} skipped: ${why}`),
    );
  } catch (err) {
    strategyProblems.push(`Lab strategies skipped: ${(err as Error).message}`);
  }
  for (const r of labList) allRules.set(r.id, r);
  // Start / stop switches from the dashboard: a stopped bot makes no new trades (its open ones are
  // still managed below).
  const controls = await loadControls(controlsPathFor(opts.ledgerPath));
  const stopped = (id: string) => isStopped(controls, id);
  const rules = [
    ...enabledRules(file),
    ...leagueList.filter((r) => r.enabled && !file.rules.some((x) => x.id === r.id)),
    ...labList.filter((r) => r.enabled),
  ].filter((r) => !stopped(r.id));
  // arbCfg gates finding / opening new arbs; open arbs are always managed (see arbCtx).
  const arbCfg = stopped(ARB_RULE_ID) ? undefined : arbConfig(file);
  const arbManageCfg = file.arbitrage ?? ArbitrageSchema.parse({ enabled: false });
  const arbRule = arbitrageAsRule(arbManageCfg);

  return withLedgerLock(opts.ledgerPath, async () => {
    // "Reset portfolio" on the dashboard: archive the ledger and start a new one, once per request.
    let resetNote: string | undefined;
    if (controls.resetRequestedAt) {
      const before = await loadLedger(opts.ledgerPath, { demo });
      if (before.resetFrom?.request !== controls.resetRequestedAt) {
        const r = await resetLedger(opts.ledgerPath, { demo, now, request: controls.resetRequestedAt });
        resetNote = `Portfolio reset: starting over at $0. ${r.closed} closed and ${r.open} open paper trade(s) (${r.pnlUsd >= 0 ? "+" : "−"}$${Math.abs(r.pnlUsd).toFixed(2)})${r.archive ? ` saved to ${r.archive}` : ""}.`;
      }
    }
    const ledger = await loadLedger(opts.ledgerPath, { demo });
    if (resetNote) await push({ at: now.toISOString(), type: "info", message: resetNote });
    let opened = 0;
    let closed = 0;
    let realized = 0;
    const arb = { opportunities: [] as ArbOpportunity[], opened: 0, closed: 0, realizedPnlUsd: 0 };

    for (const message of strategyProblems) await push({ at: now.toISOString(), type: "adapter_error", message });

    // Start pressed on the dashboard: lift that bot's loss pause (once per press).
    for (const [id, at] of Object.entries(controls.resumed)) {
      const rs = ledger.ruleState[id];
      if (!rs || (rs.resumedAt && rs.resumedAt >= at)) continue;
      const wasPaused = !!rs.pausedUntil && Date.parse(rs.pausedUntil) > now.getTime();
      ledger.ruleState[id] = { consecutiveLosses: 0, resumedAt: at };
      if (wasPaused) {
        await push({ at: now.toISOString(), type: "info", ruleId: id, message: `${allRules.get(id)?.name ?? id}: started from the dashboard, loss pause lifted` });
      }
    }
    // A bot set to never pause (fire_after_n_losses: 0) drops a pause left over from older settings.
    for (const r of allRules.values()) {
      const rs = ledger.ruleState[r.id];
      if (r.risk.fire_after_n_losses === 0 && rs?.pausedUntil) delete rs.pausedUntil;
    }
    await push({
      at: now.toISOString(),
      type: "scan_start",
      message:
        `Paper cycle: ${rules.length} rule(s)${arbCfg ? " + arbitrage" : ""}, ${openPositions(ledger).length} open position(s)${demo ? " [DEMO]" : ""}` +
        (controls.allStopped ? " — ALL BOTS STOPPED from the dashboard: managing open trades only" : ""),
      data: { rulesPath: opts.rulesPath, ledger: opts.ledgerPath, demo },
    });

    const platforms = new Set<PlatformId>(platformsFromRules(rules));
    if (arbCfg) {
      platforms.add("kalshi");
      platforms.add(arbCfg.cross_platform.with);
    }
    for (const p of openPositions(ledger)) platforms.add(p.platform);
    // Open parlays are settled leg by leg, so their legs' exchanges are needed too.
    for (const p of Object.values(ledger.parlays ?? {})) if (p.status === "open") for (const l of p.legs) platforms.add(l.platform);
    // Copies need their venues' adapters for fees and contract steps.
    if (copyCfg?.enabled && (!demo || opts.copyDeps)) for (const v of copyCfg.copy.venues) platforms.add(v);

    let adapters: PlatformAdapter[];
    try {
      adapters =
        opts.adapters ??
        createAdapters({ demo, platforms: [...platforms], fixturePath: opts.fixturePath });
      if (opts.wrapAdapters) adapters = opts.wrapAdapters(adapters);
    } catch (err) {
      await push({ at: now.toISOString(), type: "adapter_error", message: (err as Error).message });
      return { events, opened, closed, realizedPnlUsd: realized, arb };
    }
    const adapterFor = (id: PlatformId) => adapters.find((a) => a.id === id);

    const limit = opts.limitPerPlatform ?? 80;
    const leagues = leaguesWanted(rules);
    const { markets: fetched, failed } = await fetchMarkets(adapters, arbScanLimit(arbCfg, limit), push, leagues);
    // Per-market rules see the usual top `limit` per platform (plus every game in a league a rule is
    // limited to); arbitrage matching sees the wider scan.
    const markets = marketsForRules(fetched, limit, leagues);
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
    /**
     * A current read for trading on: in a quick check, a cached snapshot isn't good enough, so
     * use the live-quoted one or read REST again (adapters wrapped for fast mode expose `inner`).
     */
    const freshMarket = async (platform: PlatformId, id: string): Promise<NormalizedMarket | null | undefined> => {
      const adapter = adapterFor(platform);
      if (!adapter?.getMarket || failed.has(platform)) return undefined;
      const m = await adapter.getMarket(id);
      if (!opts.fastTick || m?.quotedAt) return m;
      const inner = (adapter as { inner?: PlatformAdapter }).inner;
      return inner?.getMarket ? inner.getMarket(id) : m;
    };

    // ---- Copy trading: refresh leaders, read their new bets (sells are needed for exits below).
    let copyCtx: CopyCtx | undefined;
    let copyPoll: CopyPoll | undefined;
    let copyView: CopyView | undefined;
    let copyRisk = copyRule ? riskStateFromLedger(ledger, copyRule.id, now) : undefined;
    // Open copies keep following their leader's sells even after copy trading is switched off.
    const hasOpenCopies = openPositions(ledger).some((p) => p.ruleId === COPY_RULE_ID);
    // Demo data has no real traders to follow (tests inject their own lookups).
    if (copyCfg && copyRule && (copyCfg.enabled || hasOpenCopies) && (!demo || opts.copyDeps)) {
      let universeMarkets: NormalizedMarket[] | undefined;
      let pairs: import("../rules/schema.js").ArbPairsFile | undefined;
      if (file.arbitrage) pairs = await loadPairsFile(pairsFilePath(opts.rulesPath, file.arbitrage)).catch(() => undefined);
      copyCtx = {
        pairs,
        freshMarket,
        cfg: copyCfg,
        rule: copyRule,
        ledger,
        now,
        push,
        statePath: copyStatePathFor(opts.ledgerPath),
        stopped: stopped(COPY_RULE_ID),
        deps: opts.copyDeps ?? defaultCopyDeps(),
        venueMarkets: () => [...fetched, ...(universeMarkets ?? [])],
        skipMarket: (rule, market, side) => skipMarket(rule, market, side),
        feePerContract: (market, price) => {
          if (copyCfg.paper.include_fees === false) return 0;
          const fee = adapterFor(market.platform)?.estimateTakerFeeUsd?.(100, price, market) ?? 0;
          return fee / 100;
        },
        buy: async (market, side, checks) => {
          const gate = checkEntryRisk(copyRule, copyRisk!, now, buyPrice(market, side, copyRule.paper.slippage));
          const all: Check[] = [...checks, { stage: "position", name: "Position", ok: true, detail: "not already holding, no re-entry cool-down, ask available" }, ...gate.checks];
          if (!gate.ok) return { ok: false, reason: gate.reason ?? "risk limits", checks: all };
          const res = await paperBuy(copyRule, market, side, gate.sizeUsd ?? 0, all);
          if (!res) return { ok: false, reason: "size buys less than one contract", checks: all };
          copyRisk!.openPositions += 1;
          if (copyRisk!.openExposureUsd != null) copyRisk!.openExposureUsd += res.exposureUsd;
          return { ok: true, position: res.position };
        },
      };
      try {
        universeMarkets = (await loadUniverse(universePathFor(opts.ledgerPath))).markets();
        copyPoll = await pollCopy(copyCtx, { force: !opts.fastTick });
      } catch (err) {
        await push({ at: now.toISOString(), type: "adapter_error", ruleId: copyRule.id, message: `Copy trading: ${(err as Error).message}` });
      }
    }

    const hasOpenArbs = Object.values(ledger.arbGroups ?? {}).some((g) => g.status === "open");
    const arbCtx =
      arbCfg || hasOpenArbs
        ? { ledger, cfg: arbManageCfg, rule: arbRule, env: quoteEnv(arbManageCfg, adapters, now), now, push, getMarket }
        : undefined;
    // Arbitrage groups are managed as a whole: sell every leg early when that already pays in full.
    // Not in quick checks: an arb's legs may be on a platform without a live stream.
    if (arbCtx && !opts.fastTick) await unwindArbGroups(arbCtx);

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
      // Quick checks act only on a live streamed quote; anything else waits for the full check.
      if (opts.fastTick && !market.quotedAt) continue;
      noteClosing(pos, market, now);

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
        markPosition(pos, mid, now, "open", { tradable: false });
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
        const soldBy = pos.ruleId === COPY_RULE_ID && copyCfg ? leaderSold(copyPoll, pos, copyCfg) : null;
        // Stops look at the mid, not a bid that may have vanished for a moment.
        const held = heldQuotes(market, pos.side);
        const stopAt = held.bid != null && held.ask != null ? (held.bid + held.ask) / 2 : mark;
        let decision =
          (rule ? evaluateExit(rule.exit, pos, market, mark, now, stopAt) : null) ??
          (soldBy ? { reason: "leader_sold" as const, detail: soldBy } : null);
        if (decision && isLossExit(decision.reason)) {
          // A loss is only taken on a sane book, and only if it's still there on a second look.
          const spread = held.bid != null && held.ask != null ? held.ask - held.bid : undefined;
          const pending = pos.exitPending;
          if (spread != null && spread > EXIT_MAX_SPREAD + 1e-9) {
            decision = null;
            if (pending?.reason !== "wide_book") {
              pos.exitPending = { reason: "wide_book", since: now.toISOString() };
              await push({ at: now.toISOString(), type: "info", ruleId: pos.ruleId, message: `${key}: stop hit but the book is ${Math.round(spread * 100)}¢ wide; not selling into it`, market: marketRef(market) });
            }
          } else if (!pending || pending.reason !== decision.reason) {
            pos.exitPending = { reason: decision.reason, since: now.toISOString() };
            decision = null;
          } else if (now.getTime() - Date.parse(pending.since) < STOP_CONFIRM_SEC * 1000) {
            decision = null;
          } else {
            decision = { ...decision, detail: `${decision.detail}; still there after ${Math.round((now.getTime() - Date.parse(pending.since)) / 1000)}s` };
          }
        } else if (pos.exitPending) {
          delete pos.exitPending; // the dip came back
        }
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
          ...rs,
          consecutiveLosses: after.consecutiveLosses,
          pausedUntil: after.pausedUntil,
        };
        for (const e of riskEvents) await push(e);
      }
    }

    // Parlays settle leg by leg (full checks only: legs may be on a platform without a live stream).
    const parlays = { opened: 0, closed: 0, realizedPnlUsd: 0 };
    if (!opts.fastTick && Object.values(ledger.parlays ?? {}).some((p) => p.status === "open")) {
      const s = await settleParlays(ledger, getMarket, now, push);
      parlays.closed = s.closed;
      parlays.realizedPnlUsd = s.realizedPnlUsd;
    }

    // Arbitrage groups whose legs have all settled are scored once, as one trade.
    if (arbCtx && !opts.fastTick) {
      const f = await finalizeArbGroups(arbCtx);
      arb.closed += f.closed;
      arb.realizedPnlUsd += f.realizedPnlUsd;
    }

    // Closing prices for bets whose game has started (and, once, for recent bets from before tracking).
    if (!opts.fastTick) {
      await backfillStarts(ledger, adapterFor, now).catch(() => undefined);
      await finalizeClosings(ledger, adapterFor, now).catch(() => undefined);
    }

    // ---- 2. Entries ---------------------------------------------------------------
    if (!opts.paperAll && rules.length > 0 && !rules.some((r) => papersRule(r))) {
      await push({
        at: now.toISOString(),
        type: "info",
        message: "No enabled rules have action: paper — signals will alert only. Use --paper-all to paper every rule.",
      });
    }

    // Fast checks only look for paper trades; alerts repeat on the full checks.
    const entryRules = opts.fastTick ? rules.filter((r) => papersRule(r, opts.paperAll)) : rules;
    const riskByRule = new Map<string, RiskState>(
      entryRules.map((r) => [r.id, riskStateFromLedger(ledger, r.id, now)]),
    );
    const history = new Map<string, PriorPrice>(Object.entries(ledger.lastPrices));
    // Price / volume history for unusual-move rules, kept next to the ledger.
    const seriesPath = seriesPathFor(opts.ledgerPath);
    const series = await loadSeries(seriesPath);
    if (!opts.fastTick) series.record(markets, now);

    const skipMarket = (rule: Rule, market: NormalizedMarket, side: "yes" | "no"): string | null => {
      if (findOpenPosition(ledger, rule.id, market.platform, market.id)) return "already holding";
      const exitedAt = lastExitAt(ledger, rule.id, market.platform, market.id);
      if (exitedAt) {
        const hrs = (now.getTime() - new Date(exitedAt).getTime()) / 3600_000;
        if (hrs < rule.risk.reentry_cooldown_hours) return "re-entry cooldown";
      }
      // The cooldown covers the whole game: no buying a sibling market right after a stop.
      const ek = eventKeyOf(market);
      if (ek && rule.risk.reentry_cooldown_hours > 0) {
        const recent = ledger.positions.some(
          (p) => p.ruleId === rule.id && p.status === "closed" && p.exitAt && p.eventKey === ek && (now.getTime() - Date.parse(p.exitAt)) / 3600_000 < rule.risk.reentry_cooldown_hours,
        );
        if (recent) return "re-entry cooldown (same game)";
      }
      if (!canTrade(market, side, "buy")) return "no ask";
      const price = buyPrice(market, side, rule.paper.slippage);
      if (!(price > 0 && price < 1)) return "no executable price";
      if (rule.entry.max_buy_price != null && price > rule.entry.max_buy_price + 1e-9) {
        return `price ${cents(price)} is above its ${cents(rule.entry.max_buy_price)} limit`;
      }
      // A pre-game move shows up on every market of a game at once (one team up, the other down):
      // one bet per game.
      if ((rule.entry.pregame_move || rule.entry.sharp_edge) && openPositions(ledger).some((p) => p.ruleId === rule.id && sameGame(p, market))) return "already holding this game";
      // No stacking: one league strategy per game. Many league strategies think alike, so
      // several of them on one game is really one big bet.
      if (rule.id.startsWith(MEMBER_PREFIX)) {
        const holder = openPositions(ledger).find((p) => p.ruleId.startsWith(MEMBER_PREFIX) && sameGame(p, market));
        if (holder) return holder.ruleId === rule.id ? "already holding this game" : "another league strategy already holds this game";
      }
      return null;
    };

    let entrySignals = 0;
    let trace: ScanTrace | undefined;
    let arbTrace: import("./arb-runtime.js").ArbTrace | undefined;
    let skipReasons: Record<string, number> = {};
    // Quick checks only enter on markets with a live streamed quote.
    const entryMarkets = opts.fastTick ? markets.filter((m) => m.quotedAt) : markets;
    if (entryMarkets.length > 0 && entryRules.length > 0) {
      const hourly = await loadHourly(entryRules.filter((r) => !stopped(r.id)), entryMarkets, adapterFor, now);
      const sharp = await loadSharp(file.sharp_lines, entryRules.filter((r) => !stopped(r.id)), entryMarkets, sharpPathFor(opts.ledgerPath), now, {
        key: opts.sharpDeps?.key ?? (demo ? "" : undefined),
        fetchImpl: opts.sharpDeps?.fetchImpl,
        mayFetch: !opts.fastTick,
      });
      for (const m of sharp.notes) await push({ at: now.toISOString(), type: "info", message: m });
      for (const m of sharp.problems) await push({ at: now.toISOString(), type: "adapter_error", message: m });
      const res = await evaluateRules({
        rules: entryRules,
        markets: entryMarkets,
        mode: "paper",
        now,
        push,
        history,
        riskByRule,
        paperAll: opts.paperAll,
        series,
        hourly,
        fair: sharp.fair,
        fairWhy: sharp.why,
        skipMarket,
        onSignal: async ({ rule, market, side, sizeUsd, checks }) => {
          if (!papersRule(rule, opts.paperAll)) return false;
          const res = await paperBuy(rule, market, side, sizeUsd, checks);
          return res ? { exposureUsd: res.exposureUsd, fill: res.fill } : false;
        },
      });
      entrySignals = res.signals;
      trace = res.trace;
      skipReasons = res.skipReasons;
      if (!opts.fastTick) {
        for (const [k, v] of history) ledger.lastPrices[k] = v;
        pruneLastPrices(ledger, now);
      }
    }

    // Copy trading entries, after this cycle's exits (so a loss pause they armed applies).
    if (copyCtx && copyPoll && copyRule) {
      if (copyPoll.polled && copyCfg!.enabled) {
        copyRisk = riskStateFromLedger(ledger, copyRule.id, now);
        try {
          await enterCopies(copyCtx, copyPoll);
        } catch (err) {
          await push({ at: now.toISOString(), type: "adapter_error", ruleId: COPY_RULE_ID, message: `Copy trading: ${(err as Error).message}` });
        }
        try {
          if (!stopped(PARLAY_RULE_ID)) parlays.opened += await runParlays(copyCtx, copyPoll);
        } catch (err) {
          await push({ at: now.toISOString(), type: "adapter_error", ruleId: PARLAY_RULE_ID, message: `Parlays: ${(err as Error).message}` });
        }
      }
      copyView = buildCopyView(copyCfg!, copyPoll);
    }
    if (markets.length > 0 && !opts.fastTick) await saveSeries(seriesPath, series).catch(() => undefined);

    /** Shared paper buy: size → contracts, fee, ledger entry, trace, event. */
    async function paperBuy(rule: Rule, market: NormalizedMarket, side: "yes" | "no", sizeUsd: number, checks: Check[]) {
          const price = buyPrice(market, side, rule.paper.slippage);
          const adapter = adapterFor(market.platform);
          const contracts = adapter?.roundContracts ? adapter.roundContracts(sizeUsd / price, market) : sizeUsd / price;
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
          pos.eventKey = eventKeyOf(market);
          startTracking(pos, market, now);
          // Mark at the sell side immediately so the spread shows up as unrealized cost.
          markPosition(pos, sellPrice(market, side), now, "open");
          const fillCheck = {
            stage: "fill" as const,
            name: "Paper fill",
            ok: true,
            detail: `bought ${side.toUpperCase()} ${Number.isInteger(pos.contracts) ? pos.contracts : pos.contracts.toFixed(2)} @ ${cents(price)} = $${costUsd.toFixed(2)} + $${fee.toFixed(2)} fee (ask${rule.paper.slippage ? ` + ${cents(rule.paper.slippage)} slippage` : ""})`,
          };
          pos.entryTrace = [...checks, fillCheck];
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
          return { exposureUsd: costUsd, fill: fillCheck, position: pos };
    }

    if (arbCfg && arbCtx && fetched.length > 0 && !opts.fastTick) {
      const universePath = universePathFor(opts.ledgerPath);
      const universe = await loadUniverse(universePath);
      const { quotes, trace: aTrace } = await findOpportunities({
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
      aTrace.funnel.opened = arb.opened;
      arbTrace = aTrace;
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
    if (copyCtx && copyPoll) await saveCopy(copyCtx, copyPoll);

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
            (parlays.opened || parlays.closed ? ` Parlays: ${parlays.opened} made, ${parlays.closed} settled (${money(parlays.realizedPnlUsd)}).` : "") +
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
    return { events, opened, closed, realizedPnlUsd: Math.round(realized * 100) / 100, arb, trace, arbTrace, copy: copyView, parlays };
  });
}

export type { PaperLedger };
