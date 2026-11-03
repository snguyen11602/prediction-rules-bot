import type { CopyTradingConfig, Rule } from "../rules/schema.js";
import { PolymarketDataClient } from "../platforms/polymarket-data.js";
import { PolymarketAdapter } from "../platforms/polymarket.js";
import { PolymarketUsAdapter } from "../platforms/polymarket-us.js";
import { platformName, type EngineEvent, type NormalizedMarket, type PlatformId, type SignalSide } from "../types.js";
import type { PaperLedger, PaperPosition } from "../ledger/paper.js";
import {
  copyChecks,
  loadCopyState,
  matchGame,
  matchTitle,
  pickLeaders,
  pollLeaders,
  saveCopyState,
  usGameSlugs,
  type CopyDecision,
  type CopyState,
  type CopyTarget,
  type Leader,
  type LeaderBet,
} from "./copy.js";
import { cents, type Check } from "./trace.js";
import { marketRef } from "./runner.js";

/** Public lookups copy trading needs (injectable for tests). */
export interface CopyDeps {
  data: Pick<PolymarketDataClient, "leaderboard" | "userStats" | "closedPositions" | "trades">;
  /** Global Polymarket markets by slug (Gamma). */
  globalBySlug: (slugs: string[]) => Promise<NormalizedMarket[]>;
  /** Polymarket US markets by slug. */
  usBySlug: (slugs: string[]) => Promise<NormalizedMarket[]>;
}

export function defaultCopyDeps(): CopyDeps {
  const gamma = new PolymarketAdapter();
  const us = new PolymarketUsAdapter(undefined, { books: 0 });
  return { data: new PolymarketDataClient(), globalBySlug: (s) => gamma.getMarketsBySlug(s), usBySlug: (s) => us.getMarketsBySlug(s) };
}

/** What the dashboard shows for copy trading. */
export interface CopyView {
  enabled: boolean;
  action: "alert" | "paper";
  leaders: Leader[];
  considered: number;
  leadersAt?: string;
  checkedAt?: string;
  recent: CopyDecision[];
  note?: string;
}

export interface CopyCtx {
  cfg: CopyTradingConfig;
  rule: Rule;
  ledger: PaperLedger;
  now: Date;
  push: (e: EngineEvent) => Promise<void>;
  statePath: string;
  deps: CopyDeps;
  /** Markets already fetched this cycle (listings + cached Kalshi events) for title matching. */
  venueMarkets: () => NormalizedMarket[];
  /** Fresh quote for a market (REST or live stream). */
  getMarket: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null | undefined>;
  skipMarket: (rule: Rule, market: NormalizedMarket, side: SignalSide) => string | null;
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

/** Refresh leaders when stale, then read their new fills if a poll is due. */
export async function pollCopy(ctx: CopyCtx, opts: { force?: boolean }): Promise<CopyPoll> {
  const state = await loadCopyState(ctx.statePath);
  const now = ctx.now;
  const stale = !state.leaders || now.getTime() - Date.parse(state.leaders.at) > ctx.cfg.leaders.refresh_hours * 3600_000;
  if (stale) {
    try {
      const { list, considered } = await pickLeaders(ctx.deps.data as PolymarketDataClient, ctx.cfg);
      state.leaders = { at: now.toISOString(), list, considered };
      await ctx.push({
        at: now.toISOString(),
        type: "info",
        ruleId: ctx.rule.id,
        message: `Copy trading: following ${list.length} of ${considered} top traders (${list.map((l) => `${l.name} ${Math.round(l.winRate * 100)}%`).join(", ") || "none passed the filters"})`,
      });
    } catch (err) {
      await ctx.push({ at: now.toISOString(), type: "adapter_error", ruleId: ctx.rule.id, message: `Copy trading: couldn't read the leaderboard (${(err as Error).message})` });
    }
  }
  const leaders = state.leaders?.list ?? [];
  const due = opts.force || !state.lastPollAt || now.getTime() - Date.parse(state.lastPollAt) >= ctx.cfg.copy.poll_seconds * 1000;
  if (!due || !leaders.length) return { state, bets: [], leaders, polled: false };
  const bets = await pollLeaders(ctx.deps.data as PolymarketDataClient, leaders, state, ctx.cfg, now);
  state.lastPollAt = now.toISOString();
  return { state, bets, leaders, polled: true };
}

/** A held copy whose leader just sold that bet → why we sell too. */
export function leaderSold(poll: CopyPoll | undefined, pos: PaperPosition, cfg: CopyTradingConfig): string | null {
  const from = pos.copiedFrom;
  if (!poll || !from || !cfg.copy.follow_sells) return null;
  const sale = poll.bets.find(
    (b) =>
      b.side === "SELL" &&
      b.leader.wallet === from.wallet &&
      (b.conditionId ? b.conditionId === from.conditionId : b.slug === from.slug) &&
      b.outcome === from.outcome &&
      b.at * 1000 > Date.parse(pos.entryAt) - 60_000 &&
      b.usd >= cfg.copy.min_leader_trade_usd / 2,
  );
  return sale ? `${sale.leader.name} sold ${sale.outcome} at ${cents(sale.price)}` : null;
}

function record(state: CopyState, d: CopyDecision): void {
  state.recent.unshift(d);
  state.recent.length = Math.min(state.recent.length, MAX_RECENT);
}

/** Copy new BUY bets onto the first venue that has the same market at a fair price. */
export async function enterCopies(ctx: CopyCtx, poll: CopyPoll): Promise<{ opened: number; alerts: number }> {
  const { cfg, now, state } = { ...ctx, state: poll.state };
  const buys = poll.bets.filter((b) => b.side === "BUY" && b.usd >= cfg.copy.min_leader_trade_usd);
  let opened = 0;
  let alerts = 0;
  if (!buys.length) return { opened, alerts };

  const globals = new Map<string, NormalizedMarket>();
  try {
    for (const m of await ctx.deps.globalBySlug(buys.map((b) => b.slug ?? "").filter(Boolean))) {
      const slug = (m.raw as { slug?: string } | undefined)?.slug;
      if (slug) globals.set(slug, m);
    }
  } catch {
    // without the global market we can still try exact game slugs below
  }
  const gameSlugs = buys.flatMap((b) => (cfg.copy.venues.includes("polymarket_us") && b.slug ? usGameSlugs(b.slug) : []));
  let usGames: NormalizedMarket[] = [];
  if (gameSlugs.length) usGames = await ctx.deps.usBySlug(gameSlugs).catch(() => []);
  const venue = (p: PlatformId) => ctx.venueMarkets().filter((m) => m.platform === p);

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
    const global = bet.slug ? globals.get(bet.slug) : undefined;
    if (!global) {
      record(state, { ...base, result: "skipped", reason: "couldn't look up the leader's market" });
      continue;
    }
    if ((global.status ?? "open") !== "open") {
      record(state, { ...base, result: "skipped", reason: "the leader's market already closed" });
      continue;
    }

    // Try the venues in order: exact game first, then a strict title match.
    let target: CopyTarget | undefined;
    const misses: string[] = [];
    for (const v of cfg.copy.venues) {
      const tries: Array<CopyTarget | { reason: string }> =
        v === "polymarket_us"
          ? [matchGame(global, usGames.filter((m) => usGameSlugs(bet.slug ?? "").includes(String((m.raw as { slug?: string })?.slug))), bet.outcome), matchTitle(global, v, venue(v), bet.outcome, cfg)]
          : [matchTitle(global, v, venue(v), bet.outcome, cfg)];
      const hit = tries.find((t): t is CopyTarget => "market" in t);
      if (hit) {
        target = hit;
        break;
      }
      const why = tries.map((t) => ("reason" in t ? t.reason : "")).filter(Boolean);
      // A spread or total won't match by title either; say the real reason once.
      misses.push(...(why[0]?.startsWith("only game-winner") ? [why[0]] : why));
    }
    if (!target) {
      record(state, { ...base, result: "skipped", reason: [...new Set(misses)].slice(0, 2).join("; ") || "no matching market" });
      continue;
    }

    // Re-read the target so the price check uses a current quote.
    const fresh = (await ctx.getMarket(target.market.platform, target.market.id).catch(() => null)) ?? target.market;
    target = { ...target, market: fresh };
    const checks = copyChecks(bet, global, target, cfg, now);
    const tgt = { platform: fresh.platform, id: fresh.id, title: fresh.title, side: target.side };
    const failed = checks.find((c) => !c.ok);
    if (failed) {
      record(state, { ...base, result: "skipped", reason: `${failed.name}: ${failed.detail}`, target: tgt });
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

export async function finishCopy(ctx: CopyCtx, poll: CopyPoll): Promise<CopyView> {
  await saveCopyState(ctx.statePath, poll.state).catch(() => undefined);
  return {
    enabled: ctx.cfg.enabled,
    action: ctx.cfg.action,
    leaders: poll.state.leaders?.list ?? [],
    considered: poll.state.leaders?.considered ?? 0,
    leadersAt: poll.state.leaders?.at,
    checkedAt: poll.state.lastPollAt,
    recent: poll.state.recent,
  };
}

export { loadCopyState };
