import type { ArbPairsFile, CopyTradingConfig, Rule } from "../rules/schema.js";
import { PolymarketDataClient } from "../platforms/polymarket-data.js";
import { PolymarketAdapter } from "../platforms/polymarket.js";
import { PolymarketUsAdapter } from "../platforms/polymarket-us.js";
import { platformName, type EngineEvent, type NormalizedMarket, type PlatformId, type SignalSide } from "../types.js";
import type { PaperLedger, PaperPosition } from "../ledger/paper.js";
import { KalshiAdapter } from "../platforms/kalshi.js";
import { buyPrice } from "./pricing.js";
import {
  betKey,
  copyChecks,
  isKalshiWallet,
  kalshiGameEvents,
  matchKalshiGame,
  loadCopyState,
  matchGame,
  matchTitle,
  pickKalshiLeaders,
  pickLeaders,
  pollKalshiLeaders,
  pollLeaders,
  saveCopyState,
  usGameSlugs,
  type CopyDecision,
  type CopyState,
  type CopyTarget,
  type Leader,
  type LeaderBet,
  type LegCandidate,
  type ParlayDecision,
} from "./copy.js";
import { KalshiSocialClient } from "../platforms/kalshi-social.js";
import { addLeg, buildParlays, copyLeaderParlays, type ParlayCtx } from "./parlays.js";
import { cents, type Check } from "./trace.js";
import { marketRef } from "./runner.js";

/** Public lookups copy trading needs (injectable for tests). */
export interface CopyDeps {
  data: Pick<PolymarketDataClient, "leaderboard" | "userStats" | "closedPositions" | "trades">;
  /** Global Polymarket markets by slug (Gamma). */
  globalBySlug: (slugs: string[]) => Promise<NormalizedMarket[]>;
  /** Polymarket US markets by slug. */
  usBySlug: (slugs: string[]) => Promise<NormalizedMarket[]>;
  /** Kalshi markets of one event (a game), [] when there's no such event. */
  kalshiEvent?: (eventTicker: string) => Promise<NormalizedMarket[]>;
  /** Kalshi's public leaderboard and trader profiles (no Kalshi leaders without it). */
  kalshiSocial?: Pick<KalshiSocialClient, "leaderboard" | "metrics" | "trades">;
  /** One Kalshi market, settled or not (for how a leader's past parlays went). */
  kalshiMarket?: (ticker: string) => Promise<NormalizedMarket | null>;
}

export function defaultCopyDeps(): CopyDeps {
  const gamma = new PolymarketAdapter();
  const us = new PolymarketUsAdapter(undefined, { books: 0 });
  const kalshi = new KalshiAdapter();
  return {
    data: new PolymarketDataClient(),
    globalBySlug: (s) => gamma.getMarketsBySlug(s),
    usBySlug: (s) => us.getMarketsBySlug(s),
    kalshiEvent: (t) => kalshi.getEventMarkets(t),
    kalshiSocial: new KalshiSocialClient(),
    kalshiMarket: (t) => kalshi.getMarket(t),
  };
}

/** What the dashboard shows for copy trading. */
export interface CopyView {
  enabled: boolean;
  action: "alert" | "paper";
  /** Everyone followed: global Polymarket first, then Kalshi. */
  leaders: Leader[];
  considered: number;
  leadersAt?: string;
  kalshi?: { enabled: boolean; considered: number; hidden: number; at?: string; count: number };
  checkedAt?: string;
  recent: CopyDecision[];
  note?: string;
  parlays?: ParlayView;
}

export interface ParlayView {
  enabled: boolean;
  action: "alert" | "paper";
  legsPerParlay: number;
  minLegPrice: number;
  maxLegPrice: number;
  minBackingUsd: number;
  /** Legs waiting to be combined (best-backed first). */
  pool: LegCandidate[];
  recent: ParlayDecision[];
}

export interface CopyCtx {
  cfg: CopyTradingConfig;
  rule: Rule;
  ledger: PaperLedger;
  now: Date;
  push: (e: EngineEvent) => Promise<void>;
  statePath: string;
  /** Stopped from the dashboard: bets are still read and matched (for exits and parlays), not copied. */
  stopped?: boolean;
  deps: CopyDeps;
  /** Markets already fetched this cycle (listings + cached Kalshi events) for title matching. */
  venueMarkets: () => NormalizedMarket[];
  /** A current, tradeable read of a market (not a cached snapshot), or null. */
  freshMarket: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null | undefined>;
  /** Pairs from arb-pairs.yaml: confirmed Kalshi ↔ global pairs are copy targets, blocked ones never are. */
  pairs?: ArbPairsFile;
  skipMarket: (rule: Rule, market: NormalizedMarket, side: SignalSide) => string | null;
  /** Taker fee per contract at `price` on this market's exchange (to compare venues fairly). */
  feePerContract: (market: NormalizedMarket, price: number) => number;
  /** Paper-buy through the shared risk gate; returns false (with a reason) when it doesn't fill. */
  buy: (market: NormalizedMarket, side: SignalSide, checks: Check[]) => Promise<{ ok: true; position: PaperPosition } | { ok: false; reason: string; checks: Check[] }>;
}

export interface CopyPoll {
  state: CopyState;
  bets: LeaderBet[];
  leaders: Leader[];
  polled: boolean;
}

const MAX_RECENT = 40;
const RETRY_MS = 15 * 60_000;

/** Refresh leaders when stale, then read new fills (leaders + wallets we still hold copies from). */
export async function pollCopy(ctx: CopyCtx, opts: { force?: boolean }): Promise<CopyPoll> {
  const state = await loadCopyState(ctx.statePath);
  const now = ctx.now;
  const stale = !state.leaders || now.getTime() - Date.parse(state.leaders.at) > ctx.cfg.leaders.refresh_hours * 3600_000;
  const mayRetry = !state.leadersRetryAt || now.getTime() >= Date.parse(state.leadersRetryAt);
  if (ctx.cfg.enabled && stale && mayRetry) {
    try {
      const { list, considered, failed } = await pickLeaders(ctx.deps.data as PolymarketDataClient, ctx.cfg);
      if (considered > 0 && failed > considered / 2) {
        // Mostly unreadable (rate limits, outage): keep the old list and try again soon.
        throw new Error(`${failed} of ${considered} trader profiles couldn't be read`);
      }
      state.leaders = { at: now.toISOString(), list, considered };
      state.leadersRetryAt = undefined;
      await ctx.push({
        at: now.toISOString(),
        type: "info",
        ruleId: ctx.rule.id,
        message: `Copy trading: following ${list.length} of ${considered} top traders (${list.map((l) => `${l.name} ${Math.round(l.winRate * 100)}%`).join(", ") || "none passed the filters"})`,
      });
    } catch (err) {
      state.leadersRetryAt = new Date(now.getTime() + RETRY_MS).toISOString();
      await ctx.push({
        at: now.toISOString(),
        type: "adapter_error",
        ruleId: ctx.rule.id,
        message: `Copy trading: couldn't refresh the leader list (${(err as Error).message}); keeping the last one, retrying in 15 min`,
      });
    }
  }
  // Kalshi's leaderboard: a second, separate list (its own retry, so one outage doesn't stop the other).
  const K = ctx.cfg.kalshi_leaders;
  const social = ctx.deps.kalshiSocial;
  const kStale = !state.kalshiLeaders || now.getTime() - Date.parse(state.kalshiLeaders.at) > ctx.cfg.leaders.refresh_hours * 3600_000;
  const kMayRetry = !state.kalshiRetryAt || now.getTime() >= Date.parse(state.kalshiRetryAt);
  if (ctx.cfg.enabled && K.enabled && social && kStale && kMayRetry) {
    try {
      const lookup = ctx.deps.kalshiMarket;
      const nowSec = Math.floor(now.getTime() / 1000);
      const cache = (state.comboResults ??= {});
      for (const [t, v] of Object.entries(cache)) if (v.at < nowSec - 30 * 86_400) delete cache[t];
      const comboResult =
        ctx.cfg.parlays.enabled && ctx.cfg.parlays.copy_leader_parlays && lookup
          ? async (t: string) => {
              if (cache[t]) return cache[t].r;
              const m = await lookup(t);
              if (!m) return null;
              if (m.status !== "resolved") return "open" as const;
              const r = m.resolvedOutcome === "yes" ? ("won" as const) : m.resolvedOutcome === "no" ? ("lost" as const) : null;
              if (r) cache[t] = { r, at: nowSec };
              return r;
            }
          : undefined;
      const { list, considered, hidden, failed } = await pickKalshiLeaders(social, ctx.cfg, comboResult, (state.kalshiPrivate ??= {}), now);
      if (considered > 0 && failed > considered / 2) throw new Error(`${failed} of ${considered} Kalshi profiles couldn't be read`);
      state.kalshiLeaders = { at: now.toISOString(), list, considered, hidden };
      state.kalshiRetryAt = undefined;
      await ctx.push({
        at: now.toISOString(),
        type: "info",
        ruleId: ctx.rule.id,
        message:
          `Copy trading: following ${list.length} Kalshi traders of the top ${considered} (${hidden} keep their trades private)` +
          (list.length ? `: ${list.map((l) => l.name).join(", ")}` : ""),
      });
    } catch (err) {
      state.kalshiRetryAt = new Date(now.getTime() + RETRY_MS).toISOString();
      await ctx.push({
        at: now.toISOString(),
        type: "adapter_error",
        ruleId: ctx.rule.id,
        message: `Copy trading: couldn't refresh Kalshi's leaderboard (${(err as Error).message}); keeping the last list, retrying in 15 min`,
      });
    }
  }
  const leaders = ctx.cfg.enabled ? [...(state.leaders?.list ?? []), ...(K.enabled ? state.kalshiLeaders?.list ?? [] : [])] : [];

  // Anyone we still hold a copy from is polled too, so their sells are never missed.
  const wallets = new Map<string, { leader: Leader; since?: number }>(leaders.map((l) => [l.wallet.toLowerCase(), { leader: l }]));
  for (const p of ctx.ledger.positions) {
    if (p.status !== "open" || !p.copiedFrom) continue;
    const k = p.copiedFrom.wallet.toLowerCase();
    const since = Math.floor(Date.parse(p.entryAt) / 1000) - 300;
    const cur = wallets.get(k);
    if (cur) cur.since = Math.min(cur.since ?? since, since);
    else
      wallets.set(k, {
        leader: { wallet: p.copiedFrom.wallet, name: p.copiedFrom.name, source: isKalshiWallet(p.copiedFrom.wallet) ? "kalshi" : "polymarket", windowPnlUsd: 0, markets: 0, decided: 0, wins: 0, winRate: 0 },
        since,
      });
  }
  const due = opts.force || !state.lastPollAt || now.getTime() - Date.parse(state.lastPollAt) >= ctx.cfg.copy.poll_seconds * 1000;
  if (!due || !wallets.size) return { state, bets: [], leaders, polled: false };
  const all = [...wallets.values()];
  const kalshiWallets = all.filter((w) => isKalshiWallet(w.leader.wallet));
  const polyWallets = all.filter((w) => !isKalshiWallet(w.leader.wallet));
  const [poly, kal] = await Promise.all([
    polyWallets.length ? pollLeaders(ctx.deps.data as PolymarketDataClient, polyWallets, state, ctx.cfg, now) : [],
    kalshiWallets.length && social ? pollKalshiLeaders(social, kalshiWallets, state, ctx.cfg, now) : [],
  ]);
  state.lastPollAt = now.toISOString();
  return { state, bets: [...poly, ...kal].sort((a, b) => b.at - a.at), leaders, polled: true };
}

/** A held copy whose leader has sold that bet since we copied it → why we sell too. */
export function leaderSold(poll: CopyPoll | undefined, pos: PaperPosition, cfg: CopyTradingConfig): string | null {
  const from = pos.copiedFrom;
  if (!poll || !from || !cfg.copy.follow_sells) return null;
  const at = poll.state.exits[betKey(from.wallet, from.conditionId ?? from.slug, from.outcome)];
  // Their sell must come after the buy we copied (a sell from before it is an older, closed bet).
  if (at == null || at * 1000 < Date.parse(from.at)) return null;
  return `${from.name} sold ${from.outcome} (${new Date(at * 1000).toISOString().slice(11, 16)} UTC)`;
}

function record(state: CopyState, d: CopyDecision): void {
  state.recent.unshift(d);
  state.recent.length = Math.min(state.recent.length, MAX_RECENT);
}

/** Copy new BUY bets onto the first venue that has the same market at a fair price. */
export async function enterCopies(ctx: CopyCtx, poll: CopyPoll): Promise<{ opened: number; alerts: number }> {
  const { cfg, now } = ctx;
  const state = poll.state;
  const nowSec = now.getTime() / 1000;
  const buys = poll.bets.filter(
    (b) =>
      b.side === "BUY" &&
      !b.combo && // a leader's parlay is handled by the parlay copier
      b.usd >= cfg.copy.min_leader_trade_usd &&
      nowSec - b.at <= cfg.copy.max_trade_age_minutes * 60 &&
      leaders(poll).has(b.leader.wallet.toLowerCase()),
  );
  let opened = 0;
  let alerts = 0;
  if (!buys.length) return { opened, alerts };

  const globalBuys = buys.filter((b) => !b.kalshiTicker);
  const globals = new Map<string, NormalizedMarket>();
  try {
    const slugs = globalBuys.map((b) => b.slug ?? "").filter(Boolean);
    for (const m of slugs.length ? await ctx.deps.globalBySlug(slugs) : []) {
      const slug = (m.raw as { slug?: string } | undefined)?.slug;
      if (slug) globals.set(slug, m);
    }
  } catch {
    // reported per bet below
  }
  const gameSlugs = globalBuys.flatMap((b) => (cfg.copy.venues.includes("polymarket_us") && b.slug ? usGameSlugs(b.slug) : []));
  const usGames = gameSlugs.length ? await ctx.deps.usBySlug(gameSlugs).catch(() => [] as NormalizedMarket[]) : [];
  const venue = (p: PlatformId) => ctx.venueMarkets().filter((m) => m.platform === p);
  const eventCache = new Map<string, Promise<NormalizedMarket[]>>();
  const kalshiEvent = (t: string) => {
    if (!eventCache.has(t)) eventCache.set(t, ctx.deps.kalshiEvent!(t).catch(() => []));
    return eventCache.get(t)!;
  };
  const blocked = new Set((ctx.pairs?.blocked ?? []).filter((b) => b.platform === "polymarket").map((b) => `${b.kalshi}|${b.polymarket}`));
  const confirmed = (ctx.pairs?.confirmed ?? []).filter((c) => c.platform === "polymarket");

  for (const bet of buys) {
    const base: Omit<CopyDecision, "result"> = {
      at: new Date(bet.at * 1000).toISOString(),
      wallet: bet.leader.wallet,
      leader: bet.leader.name,
      title: bet.title,
      outcome: bet.outcome,
      price: bet.price,
      usd: Math.round(bet.usd),
    };
    const soldAt = state.exits[betKey(bet.leader.wallet, bet.conditionId ?? bet.slug, bet.outcome)];
    if (soldAt != null && soldAt >= bet.at) {
      record(state, { ...base, result: "skipped", reason: "the leader already sold it again" });
      continue;
    }
    // A Kalshi leader's bet is copied on the very same Kalshi market: nothing to match.
    if (bet.kalshiTicker && !cfg.copy.venues.includes("kalshi")) {
      record(state, { ...base, result: "skipped", reason: "Kalshi isn't in copy.venues" });
      continue;
    }
    const global = bet.slug && !bet.kalshiTicker ? globals.get(bet.slug) : undefined;
    if (!bet.kalshiTicker && !global) {
      record(state, { ...base, result: "skipped", reason: "couldn't look up the leader's market" });
      continue;
    }
    if (global && (global.status ?? "open") !== "open") {
      record(state, { ...base, result: "skipped", reason: "the leader's market already closed" });
      continue;
    }

    // Find the same bet on each venue: a pair you confirmed, the exact game, or a strict title match.
    // Polymarket US goes first so its full team names can confirm Kalshi's game markets.
    const found: CopyTarget[] = [];
    const misses: string[] = [];
    let usTwin: NormalizedMarket | undefined;
    const venues = bet.kalshiTicker ? [] : [...cfg.copy.venues].sort((a, b) => Number(a === "kalshi") - Number(b === "kalshi"));
    if (bet.kalshiTicker) {
      const stub: NormalizedMarket = { platform: "kalshi", id: bet.kalshiTicker, title: bet.kalshiTicker, yesPrice: 0.5 };
      found.push({ market: stub, side: /^yes$/i.test(bet.outcome) ? "yes" : "no", how: "the leader's own Kalshi market" });
    }
    for (const v of venues) {
      if (!global) break;
      const tries: Array<CopyTarget | { reason: string }> = [];
      if (v === "polymarket_us") {
        const games = usGames.filter((m) => usGameSlugs(bet.slug ?? "").includes(String((m.raw as { slug?: string })?.slug)));
        const g = matchGame(global, games, bet.outcome);
        if ("market" in g) usTwin = g.market;
        tries.push(g);
        if (!("market" in g)) tries.push(matchTitle(global, v, venue(v), bet.outcome, cfg));
      } else {
        const pair = confirmed.find((c) => c.polymarket === global.id);
        const k = pair ? await ctx.freshMarket("kalshi", pair.kalshi).catch(() => null) : null;
        if (pair && k && /^(yes|no)$/i.test(bet.outcome)) {
          const yes = /^yes$/i.test(bet.outcome) !== pair.invert;
          tries.push({ market: k, side: yes ? "yes" : "no", how: "a pair you confirmed" });
        }
        if (!tries.length && ctx.deps.kalshiEvent && bet.slug && kalshiGameEvents(bet.slug).length) {
          let gameTry: CopyTarget | { reason: string } = { reason: "game not listed on Kalshi" };
          for (const ev of kalshiGameEvents(bet.slug)) {
            const markets = await kalshiEvent(ev.event);
            if (!markets.length) continue;
            gameTry = matchKalshiGame(global, markets, ev.codes, bet.outcome, usTwin);
            break;
          }
          tries.push(gameTry);
        }
        if (!tries.some((t) => "market" in t)) tries.push(matchTitle(global, v, venue(v), bet.outcome, cfg, blocked));
      }
      const hit = tries.find((t): t is CopyTarget => "market" in t);
      if (hit) found.push(hit);
      else misses.push(...tries.map((t) => ("reason" in t ? t.reason : "")).filter(Boolean));
    }
    if (!found.length) {
      const uniq = [...new Set(misses)];
      // "Not Yes/No" only matters when nothing else explains it.
      const telling = uniq.filter((r) => !/not Yes\/No$/.test(r));
      const reason = uniq.find((r) => r.startsWith("only game-winner")) ?? (telling.length ? telling : uniq).slice(0, 2).join("; ");
      record(state, { ...base, result: "skipped", reason: reason || "no matching market" });
      continue;
    }

    // Price each venue on a current read (open, real ask, all copy checks), then pick one.
    const viable: Array<{ target: CopyTarget; checks: Check[]; cost: number; pay: number }> = [];
    let firstMiss: { reason: string; tgt: CopyDecision["target"] } | undefined;
    for (const t of found) {
      const tgt = { platform: t.market.platform, id: t.market.id, title: t.market.title, side: t.side };
      const fresh = await ctx.freshMarket(t.market.platform, t.market.id).catch(() => null);
      let reason: string | undefined;
      if (!fresh) reason = `couldn't get a current price on ${platformName(t.market.platform)}`;
      else if ((fresh.status ?? "open") !== "open") reason = "that market is closed";
      else if (!(t.side === "yes" ? fresh.yesAsk != null : fresh.yesBid != null)) reason = `nobody is selling ${t.side.toUpperCase()} there right now`;
      // Kalshi leaders' trades carry only a ticker: show the market's real title.
      if (fresh && bet.kalshiTicker) base.title = fresh.title;
      let checks: Check[] = [];
      if (fresh && !reason) {
        checks = copyChecks(bet, global, { ...t, market: fresh }, cfg, now);
        const failed = checks.find((c) => !c.ok);
        if (failed) reason = `${failed.name}: ${failed.detail}`;
      }
      if (reason || !fresh) {
        firstMiss ??= { reason: reason ?? "no price", tgt };
        continue;
      }
      const pay = buyPrice(fresh, t.side, cfg.paper.slippage);
      viable.push({ target: { ...t, market: fresh }, checks, pay, cost: pay + ctx.feePerContract(fresh, pay) });
    }
    if (!viable.length) {
      record(state, { ...base, result: "skipped", reason: firstMiss?.reason ?? "no fair price", target: firstMiss?.tgt });
      continue;
    }
    const cheapest = viable.reduce((a, b) => (b.cost < a.cost ? b : a));
    const preferred = cfg.copy.prefer !== "none" ? viable.find((x) => x.target.market.platform === cfg.copy.prefer) : undefined;
    const pick = preferred && preferred.cost <= cheapest.cost + cfg.copy.prefer_within + 1e-9 ? preferred : cheapest;
    const others = viable.filter((x) => x !== pick);
    pick.checks.push({
      stage: "signal",
      name: "Venue",
      ok: true,
      detail: others.length
        ? `${platformName(pick.target.market.platform)} ${cents(pick.cost)} vs ${others.map((o) => `${platformName(o.target.market.platform)} ${cents(o.cost)}`).join(", ")} per contract with fees` +
          (pick === preferred && pick !== cheapest ? ` — within ${cents(cfg.copy.prefer_within)}, so your preferred ${platformName(pick.target.market.platform)}` : " — cheapest")
        : `only on ${platformName(pick.target.market.platform)}`,
    });
    let target = pick.target;
    const fresh = target.market;
    const checks = pick.checks;
    const tgt = { platform: fresh.platform, id: fresh.id, title: fresh.title, side: target.side };
    // A big bet on a tradable market is a possible parlay leg, whether or not the copy fills.
    addLeg(state, bet, fresh, target.side, cfg);
    if (ctx.stopped) {
      record(state, { ...base, result: "skipped", reason: "copy trading is stopped (dashboard)", target: tgt });
      continue;
    }
    const skip = ctx.skipMarket(ctx.rule, fresh, target.side);
    if (skip) {
      record(state, { ...base, result: "skipped", reason: skip, target: tgt });
      continue;
    }
    if (cfg.action === "alert") {
      alerts += 1;
      record(state, { ...base, result: "alerted", target: tgt });
      await ctx.push({
        at: now.toISOString(),
        type: "entry_signal",
        ruleId: ctx.rule.id,
        message: `COPY ALERT ${target.side.toUpperCase()} on ${platformName(fresh.platform)} — ${bet.leader.name} bought ${bet.outcome} at ${cents(bet.price)} (${fresh.title})`,
        market: marketRef(fresh),
        side: target.side,
        data: { action: "alert", copy: { wallet: bet.leader.wallet, leader: bet.leader.name } },
      });
      continue;
    }
    const res = await ctx.buy(fresh, target.side, checks);
    if (!res.ok) {
      record(state, { ...base, result: "skipped", reason: res.reason, target: tgt });
      continue;
    }
    res.position.copiedFrom = {
      wallet: bet.leader.wallet,
      name: bet.leader.name,
      conditionId: bet.conditionId,
      slug: bet.slug,
      outcome: bet.outcome,
      price: bet.price,
      at: base.at,
    };
    opened += 1;
    record(state, { ...base, result: "copied", target: { ...tgt, price: res.position.entryPrice } });
  }
  return { opened, alerts };
}

/** Only current leaders' buys are copied (others are polled just to follow their sells). */
function leaders(poll: CopyPoll): Set<string> {
  return new Set(poll.leaders.map((l) => l.wallet.toLowerCase()));
}

/** Parlays after this poll's copies: copy leaders' own parlays, then build from the leg pool. */
export async function runParlays(ctx: CopyCtx, poll: CopyPoll): Promise<number> {
  if (!ctx.cfg.parlays.enabled) return 0;
  const pctx: ParlayCtx = {
    cfg: ctx.cfg,
    ledger: ctx.ledger,
    now: ctx.now,
    push: ctx.push,
    freshMarket: ctx.freshMarket,
    feeUsd: (m, contracts, price) => ctx.feePerContract(m, price) * contracts,
  };
  const kalshiLeaders = poll.leaders.filter((l) => l.source === "kalshi");
  const copied = await copyLeaderParlays(pctx, poll.state, poll.bets, kalshiLeaders);
  const built = await buildParlays(pctx, poll.state);
  return copied + built;
}

export function copyView(cfg: CopyTradingConfig, poll: CopyPoll): CopyView {
  const P = cfg.parlays;
  const k = poll.state.kalshiLeaders;
  return {
    enabled: cfg.enabled,
    action: cfg.action,
    leaders: [...(poll.state.leaders?.list ?? []), ...(cfg.kalshi_leaders.enabled ? k?.list ?? [] : [])],
    considered: poll.state.leaders?.considered ?? 0,
    leadersAt: poll.state.leaders?.at,
    kalshi: { enabled: cfg.kalshi_leaders.enabled, considered: k?.considered ?? 0, hidden: k?.hidden ?? 0, at: k?.at, count: k?.list.length ?? 0 },
    checkedAt: poll.state.lastPollAt,
    recent: poll.state.recent,
    parlays: {
      enabled: P.enabled,
      action: P.action,
      legsPerParlay: P.legs,
      minLegPrice: P.min_leg_price,
      maxLegPrice: P.max_leg_price,
      minBackingUsd: P.min_leg_backing_usd,
      pool: (poll.state.legs ?? []).filter((l) => !l.usedAt).sort((a, b) => b.backingUsd - a.backingUsd).slice(0, 30),
      recent: poll.state.parlayRecent ?? [],
    },
  };
}

/** Save after the ledger, so a bet is never marked "seen" without its position being saved. */
export async function saveCopy(ctx: CopyCtx, poll: CopyPoll): Promise<void> {
  await saveCopyState(ctx.statePath, poll.state).catch(() => undefined);
}

export { loadCopyState };
