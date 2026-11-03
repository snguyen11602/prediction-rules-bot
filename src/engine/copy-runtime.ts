import type { ArbPairsFile, CopyTradingConfig, Rule } from "../rules/schema.js";
import { PolymarketDataClient } from "../platforms/polymarket-data.js";
import { PolymarketAdapter } from "../platforms/polymarket.js";
import { PolymarketUsAdapter } from "../platforms/polymarket-us.js";
import { platformName, type EngineEvent, type NormalizedMarket, type PlatformId, type SignalSide } from "../types.js";
import type { PaperLedger, PaperPosition } from "../ledger/paper.js";
import {
  betKey,
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
  /** A current, tradeable read of a market (not a cached snapshot), or null. */
  freshMarket: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null | undefined>;
  /** Pairs from arb-pairs.yaml: confirmed Kalshi ↔ global pairs are copy targets, blocked ones never are. */
  pairs?: ArbPairsFile;
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
  const leaders = ctx.cfg.enabled ? state.leaders?.list ?? [] : [];

  // Anyone we still hold a copy from is polled too, so their sells are never missed.
  const wallets = new Map<string, { leader: Leader; since?: number }>(leaders.map((l) => [l.wallet.toLowerCase(), { leader: l }]));
  for (const p of ctx.ledger.positions) {
    if (p.status !== "open" || !p.copiedFrom) continue;
    const k = p.copiedFrom.wallet.toLowerCase();
    const since = Math.floor(Date.parse(p.entryAt) / 1000) - 300;
    const cur = wallets.get(k);
    if (cur) cur.since = Math.min(cur.since ?? since, since);
    else wallets.set(k, { leader: { wallet: p.copiedFrom.wallet, name: p.copiedFrom.name, windowPnlUsd: 0, markets: 0, decided: 0, wins: 0, winRate: 0 }, since });
  }
  const due = opts.force || !state.lastPollAt || now.getTime() - Date.parse(state.lastPollAt) >= ctx.cfg.copy.poll_seconds * 1000;
  if (!due || !wallets.size) return { state, bets: [], leaders, polled: false };
  const bets = await pollLeaders(ctx.deps.data as PolymarketDataClient, [...wallets.values()], state, ctx.cfg, now);
  state.lastPollAt = now.toISOString();
  return { state, bets, leaders, polled: true };
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
      b.usd >= cfg.copy.min_leader_trade_usd &&
      nowSec - b.at <= cfg.copy.max_trade_age_minutes * 60 &&
      leaders(poll).has(b.leader.wallet.toLowerCase()),
  );
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
    // reported per bet below
  }
  const gameSlugs = buys.flatMap((b) => (cfg.copy.venues.includes("polymarket_us") && b.slug ? usGameSlugs(b.slug) : []));
  const usGames = gameSlugs.length ? await ctx.deps.usBySlug(gameSlugs).catch(() => [] as NormalizedMarket[]) : [];
  const venue = (p: PlatformId) => ctx.venueMarkets().filter((m) => m.platform === p);
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
    const global = bet.slug ? globals.get(bet.slug) : undefined;
    if (!global) {
      record(state, { ...base, result: "skipped", reason: "couldn't look up the leader's market" });
      continue;
    }
    if ((global.status ?? "open") !== "open") {
      record(state, { ...base, result: "skipped", reason: "the leader's market already closed" });
      continue;
    }

    // Venues in order: a pair you confirmed, the exact game, then a strict title match.
    let target: CopyTarget | undefined;
    const misses: string[] = [];
    for (const v of cfg.copy.venues) {
      const tries: Array<CopyTarget | { reason: string }> = [];
      if (v === "kalshi") {
        const pair = confirmed.find((c) => c.polymarket === global.id);
        const k = pair ? await ctx.freshMarket("kalshi", pair.kalshi).catch(() => null) : null;
        if (pair && k && /^(yes|no)$/i.test(bet.outcome)) {
          const yes = /^yes$/i.test(bet.outcome) !== pair.invert;
          tries.push({ market: k, side: yes ? "yes" : "no", how: "a pair you confirmed" });
        }
        tries.push(matchTitle(global, v, venue(v), bet.outcome, cfg, blocked));
      } else {
        const games = usGames.filter((m) => usGameSlugs(bet.slug ?? "").includes(String((m.raw as { slug?: string })?.slug)));
        tries.push(matchGame(global, games, bet.outcome), matchTitle(global, v, venue(v), bet.outcome, cfg));
      }
      const hit = tries.find((t): t is CopyTarget => "market" in t);
      if (hit) {
        target = hit;
        break;
      }
      misses.push(...tries.map((t) => ("reason" in t ? t.reason : "")).filter(Boolean));
    }
    if (!target) {
      const uniq = [...new Set(misses)];
      // "Not Yes/No" only matters when nothing else explains it.
      const telling = uniq.filter((r) => !/not Yes\/No$/.test(r));
      const reason = uniq.find((r) => r.startsWith("only game-winner")) ?? (telling.length ? telling : uniq).slice(0, 2).join("; ");
      record(state, { ...base, result: "skipped", reason: reason || "no matching market" });
      continue;
    }

    // Trade only on a current read: open, with a real ask for the side we'd buy.
    const fresh = await ctx.freshMarket(target.market.platform, target.market.id).catch(() => null);
    const tgt = { platform: target.market.platform, id: target.market.id, title: target.market.title, side: target.side };
    if (!fresh) {
      record(state, { ...base, result: "skipped", reason: `couldn't get a current price on ${platformName(target.market.platform)}`, target: tgt });
      continue;
    }
    const askKnown = target.side === "yes" ? fresh.yesAsk != null : fresh.yesBid != null;
    if ((fresh.status ?? "open") !== "open" || !askKnown) {
      record(state, { ...base, result: "skipped", reason: (fresh.status ?? "open") !== "open" ? "that market is closed" : `nobody is selling ${target.side.toUpperCase()} there right now`, target: tgt });
      continue;
    }
    target = { ...target, market: fresh };
    const checks = copyChecks(bet, global, target, cfg, now);
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

/** Only current leaders' buys are copied (others are polled just to follow their sells). */
function leaders(poll: CopyPoll): Set<string> {
  return new Set(poll.leaders.map((l) => l.wallet.toLowerCase()));
}

export function copyView(cfg: CopyTradingConfig, poll: CopyPoll): CopyView {
  return {
    enabled: cfg.enabled,
    action: cfg.action,
    leaders: poll.state.leaders?.list ?? [],
    considered: poll.state.leaders?.considered ?? 0,
    leadersAt: poll.state.leaders?.at,
    checkedAt: poll.state.lastPollAt,
    recent: poll.state.recent,
  };
}

/** Save after the ledger, so a bet is never marked "seen" without its position being saved. */
export async function saveCopy(ctx: CopyCtx, poll: CopyPoll): Promise<void> {
  await saveCopyState(ctx.statePath, poll.state).catch(() => undefined);
}

export { loadCopyState };
