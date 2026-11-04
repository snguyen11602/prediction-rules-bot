import { randomUUID } from "node:crypto";
import { PARLAY_RULE_ID, type CopyTradingConfig } from "../rules/schema.js";
import type { PaperLedger, ParlayLegRecord, ParlayRecord } from "../ledger/paper.js";
import { platformName, type EngineEvent, type NormalizedMarket, type PlatformId, type SignalSide } from "../types.js";
import { buyPrice, canTrade, sellPrice, settlementPrice } from "./pricing.js";
import { cents, usd, type Check } from "./trace.js";
import { isKalshiCombo, leaderLine, type CopyState, type LegCandidate, type Leader, type LeaderBet, type ParlayDecision } from "./copy.js";

/**
 * Parlays, paper only. Two kinds:
 *  - built: legs are single bets the leaders put big money on (70–95¢), on one exchange, one leg per
 *    game, combined by the bot;
 *  - leader: a copy of a Kalshi leader's own parlay (a combo market) when they bet big on it, have
 *    won parlays before, and every leg is still 70%+.
 * Real parlays are priced by market makers on request, so the paper price is the legs' asks
 * multiplied plus `combo_margin`. A parlay is settled leg by leg: one loss loses it, a void leg
 * drops out (and the payout shrinks to match).
 */

type ParlayCfg = CopyTradingConfig["parlays"];

const MAX_RECENT = 30;
const SEEN_TTL_SEC = 3 * 86_400;

export const legKey = (platform: PlatformId, id: string, side: SignalSide) => `${platform}:${id}:${side}`;

const GAME_SLUG = /^[a-z]+-([a-z0-9]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2})/;

/** Markets of one game share this (Kalshi event ticker; a Polymarket US game slug without its market-type prefix). */
export function gameKey(m: Pick<NormalizedMarket, "platform" | "id" | "eventId" | "raw">): string {
  if (m.platform === "kalshi" && m.eventId) return `kalshi:${m.eventId}`;
  const slug = (m.raw as { slug?: string } | undefined)?.slug;
  const g = slug ? GAME_SLUG.exec(slug) : null;
  return `${m.platform}:${g ? g[1] : slug ?? m.id}`;
}

/** Parlay price per $1 payout: the legs multiplied, plus the market makers' cut (never ≥ $1). */
export function parlayPrice(legPrices: number[], margin: number): number {
  const p = legPrices.reduce((a, x) => a * x, 1);
  return Math.min(0.99, p * (1 + margin));
}

/** Add a leader's bet to the leg pool (summing backing when several leaders bet the same outcome). */
export function addLeg(state: CopyState, bet: LeaderBet, market: NormalizedMarket, side: SignalSide, cfg: CopyTradingConfig): void {
  if (!cfg.parlays.enabled || !cfg.parlays.venues.includes(market.platform as "kalshi" | "polymarket_us")) return;
  if (market.platform === "kalshi" && isKalshiCombo(market.id)) return;
  const pool = (state.legs ??= []);
  const key = legKey(market.platform, market.id, side);
  const at = new Date(bet.at * 1000).toISOString();
  const cur = pool.find((l) => l.key === key);
  if (cur) {
    if (cur.usedAt) return;
    cur.leaderPrice = (cur.leaderPrice * cur.backingUsd + bet.price * bet.usd) / Math.max(1e-9, cur.backingUsd + bet.usd);
    cur.backingUsd += bet.usd;
    if (!cur.leaders.includes(bet.leader.name)) cur.leaders.push(bet.leader.name);
    if (at > cur.lastAt) cur.lastAt = at;
    return;
  }
  pool.push({
    key,
    platform: market.platform,
    marketId: market.id,
    side,
    title: market.title,
    url: market.url,
    game: gameKey(market),
    backingUsd: bet.usd,
    leaders: [bet.leader.name],
    leaderPrice: bet.price,
    firstAt: at,
    lastAt: at,
  });
}

/** Drop legs the leaders bought too long ago (used ones are kept a day so they're never reused). */
export function pruneLegs(state: CopyState, cfg: ParlayCfg, now: Date): void {
  const maxAge = cfg.max_leg_age_hours * 3600_000;
  state.legs = (state.legs ?? []).filter((l) => {
    const age = now.getTime() - Date.parse(l.usedAt ?? l.lastAt);
    return l.usedAt ? age < 86_400_000 : age <= maxAge;
  });
}

/**
 * Candidates for the next built parlay on `venue`: enough backing, not used yet, one per game
 * (the best-backed), games not already in an open parlay; best-backed first.
 */
export function legCandidates(pool: LegCandidate[], cfg: ParlayCfg, venue: PlatformId, busyGames: Set<string>): LegCandidate[] {
  const best = new Map<string, LegCandidate>();
  for (const l of pool) {
    if (l.platform !== venue || l.usedAt || l.backingUsd < cfg.min_leg_backing_usd || busyGames.has(l.game)) continue;
    const cur = best.get(l.game);
    if (!cur || l.backingUsd > cur.backingUsd) best.set(l.game, l);
  }
  return [...best.values()].sort((a, b) => b.backingUsd - a.backingUsd || b.leaderPrice - a.leaderPrice);
}

export interface ParlayCtx {
  cfg: CopyTradingConfig;
  ledger: PaperLedger;
  now: Date;
  push: (e: EngineEvent) => Promise<void>;
  /** A current, tradeable read of a market, or null. */
  freshMarket: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null | undefined>;
  /** Taker fee in USD for `contracts` at `price` on this market's exchange. */
  feeUsd: (market: NormalizedMarket, contracts: number, price: number) => number;
}

const openParlays = (ledger: PaperLedger) => Object.values(ledger.parlays ?? {}).filter((p) => p.status === "open");

function decide(state: CopyState, d: ParlayDecision): void {
  const list = (state.parlayRecent ??= []);
  list.unshift(d);
  list.length = Math.min(list.length, MAX_RECENT);
}

const legLine = (l: Pick<ParlayLegRecord, "side" | "title" | "entryPrice">) => `${l.side.toUpperCase()} ${l.title} ${cents(l.entryPrice)}`;

/** Paper-open (or suggest) a parlay. */
async function place(
  ctx: ParlayCtx,
  state: CopyState,
  p: Omit<ParlayRecord, "id" | "ruleId" | "status" | "openedAt" | "stakeUsd" | "feeUsd" | "payoutUsd" | "hypothetical">,
  checks: Check[],
  feeMarket: NormalizedMarket,
  decision: Omit<ParlayDecision, "at" | "result" | "price" | "legs">,
): Promise<boolean> {
  const P = ctx.cfg.parlays;
  const stake = P.stake_usd;
  const contracts = stake / p.price;
  const fee = ctx.feeUsd(feeMarket, contracts, p.price);
  const payout = Math.round(contracts * 100) / 100;
  const what = `${p.legs.length}-leg parlay on ${platformName(p.platform)} at ${cents(p.price)} (pays ${(1 / p.price).toFixed(1)}×)`;
  const legsText = p.legs.map(legLine).join(" + ");
  const base = { ...decision, at: ctx.now.toISOString(), legs: p.legs.length, price: p.price };
  if (P.action === "alert") {
    decide(state, { ...base, result: "alerted" });
    await ctx.push({ at: ctx.now.toISOString(), type: "entry_signal", ruleId: PARLAY_RULE_ID, message: `PARLAY IDEA ${what}: ${legsText}`, data: { action: "alert", parlay: { source: p.source, price: p.price } } });
    return true;
  }
  const rec: ParlayRecord = {
    ...p,
    id: randomUUID(),
    ruleId: PARLAY_RULE_ID,
    status: "open",
    openedAt: ctx.now.toISOString(),
    stakeUsd: stake,
    feeUsd: fee,
    payoutUsd: payout,
    // Worth now: the legs at their sell prices (the spread and the cut show up as an open loss).
    markValueUsd: round2(contracts * p.legs.reduce((a, l) => a * (l.status === "won" ? 1 : l.lastPrice ?? l.entryPrice), 1)),
    entryTrace: [
      ...checks,
      { stage: "fill", name: "Paper fill", ok: true, detail: `$${stake.toFixed(2)} at ${cents(p.price)} → pays $${payout.toFixed(2)} if every leg wins (+ $${fee.toFixed(2)} fee)` },
    ],
    hypothetical: true,
  };
  (ctx.ledger.parlays ??= {})[rec.id] = rec;
  decide(state, { ...base, result: "opened" });
  await ctx.push({
    at: ctx.now.toISOString(),
    type: "paper_fill",
    ruleId: PARLAY_RULE_ID,
    message: `Paper ${what}: $${stake.toFixed(2)} to win $${payout.toFixed(2)} — ${legsText}`,
    sizeUsd: stake,
    data: { parlayId: rec.id, price: p.price, legs: p.legs.length, feeUsd: fee },
  });
  return true;
}

/** Combine the best-backed 70%+ legs into parlays (one exchange each, one leg per game). */
export async function buildParlays(ctx: ParlayCtx, state: CopyState): Promise<number> {
  const P = ctx.cfg.parlays;
  if (!P.enabled) return 0;
  pruneLegs(state, P, ctx.now);
  let made = 0;
  for (const venue of P.venues) {
    for (;;) {
      if (openParlays(ctx.ledger).length + (P.action === "alert" ? made : 0) >= P.max_open) return made;
      const busy = new Set(openParlays(ctx.ledger).flatMap((p) => p.legs.filter((l) => l.status === "open" && l.game).map((l) => l.game!)));
      const cands = legCandidates(state.legs ?? [], P, venue, busy);
      if (cands.length < P.legs) break;
      // Price the candidates on a current read; keep the ones still between the price limits.
      const priced: Array<{ c: LegCandidate; m: NormalizedMarket; price: number }> = [];
      for (const c of cands.slice(0, P.legs * 3)) {
        const m = await ctx.freshMarket(c.platform, c.marketId).catch(() => null);
        if (!m || (m.status ?? "open") !== "open" || !canTrade(m, c.side, "buy")) {
          c.usedAt = ctx.now.toISOString(); // closed or no seller: drop it
          continue;
        }
        const price = buyPrice(m, c.side);
        if (price < P.min_leg_price - 1e-9 || price > P.max_leg_price + 1e-9) continue;
        priced.push({ c, m, price });
        if (priced.length >= P.legs) break;
      }
      if (priced.length < P.legs) break;
      const price = parlayPrice(priced.map((x) => x.price), P.combo_margin);
      const legs: ParlayLegRecord[] = priced.map(({ c, m, price: px }) => ({
        platform: c.platform,
        marketId: c.marketId,
        side: c.side,
        title: m.title,
        url: m.url ?? c.url,
        game: c.game,
        entryPrice: px,
        status: "open",
        lastPrice: sellPrice(m, c.side),
        backing: { usd: Math.round(c.backingUsd), leaders: c.leaders },
      }));
      const checks: Check[] = [
        ...priced.map(({ c, price: px }, i) => ({
          stage: "filters" as const,
          name: `Leg ${i + 1}`,
          ok: true,
          detail: `${c.side.toUpperCase()} ${c.title} at ${cents(px)} — ${c.leaders.join(", ")} put ${usd(c.backingUsd)} on it`,
        })),
        {
          stage: "signal",
          name: "Parlay price",
          ok: true,
          detail: `${priced.map((x) => cents(x.price)).join(" × ")} = ${cents(priced.reduce((a, x) => a * x.price, 1))}, + ${Math.round(P.combo_margin * 100)}% market-maker cut = ${cents(price)}`,
        },
      ];
      for (const x of priced) x.c.usedAt = ctx.now.toISOString();
      await place(ctx, state, { source: "built", platform: venue, legs, price }, checks, priced[0].m, {
        kind: "built",
        title: legs.map((l) => l.title).join(" + "),
      });
      made += 1;
    }
  }
  return made;
}

interface KalshiComboLeg {
  market_ticker?: string;
  side?: string;
}

/** Copy Kalshi leaders' own parlays: big stake, won before, every leg still 70%+. */
export async function copyLeaderParlays(ctx: ParlayCtx, state: CopyState, bets: LeaderBet[], leaders: Leader[]): Promise<number> {
  const P = ctx.cfg.parlays;
  if (!P.enabled || !P.copy_leader_parlays || !P.venues.includes("kalshi")) return 0;
  const nowSec = ctx.now.getTime() / 1000;
  const current = new Set(leaders.map((l) => l.wallet.toLowerCase()));
  const seen = (state.parlaySeen ??= {});
  for (const [k, at] of Object.entries(seen)) if (at < nowSec - SEEN_TTL_SEC) delete seen[k];
  let made = 0;
  // Parlays that couldn't be read last time come back while they're still fresh.
  const retry: LeaderBet[] = [];
  /** Games in parlays made (or suggested) this round. */
  const suggested = new Set<string>();
  const todo = [...(state.parlayPending ?? []), ...bets];
  for (const bet of todo) {
    if (!bet.combo || bet.side !== "BUY" || !/^yes$/i.test(bet.outcome) || !bet.kalshiTicker) continue;
    if (!current.has(bet.leader.wallet.toLowerCase()) || nowSec - bet.at > ctx.cfg.copy.max_trade_age_minutes * 60) continue;
    const key = `${bet.leader.wallet.toLowerCase()}|${bet.kalshiTicker}`;
    if (seen[key]) continue;
    // Small parlays are everyday noise; only report the ones near the stake you asked for.
    if (bet.usd < P.min_leader_parlay_usd / 4) continue;
    seen[key] = Math.floor(nowSec);
    const L = bet.leader;
    let title = bet.kalshiTicker;
    const skip = (reason: string, legs = 0) =>
      decide(state, { at: ctx.now.toISOString(), kind: "leader", result: "skipped", title, legs, leader: L.name, usd: Math.round(bet.usd), reason });
    /** Couldn't read Kalshi just now: try again on the next check while the bet is fresh. */
    const later = () => {
      delete seen[key];
      retry.push(bet);
    };
    if (bet.usd < P.min_leader_parlay_usd) {
      skip(`${usd(bet.usd)} on it (needs ≥ ${usd(P.min_leader_parlay_usd)})`);
      continue;
    }
    const rec = L.parlays ?? { won: 0, lost: 0, open: 0 };
    if (rec.won < P.min_leader_parlay_wins) {
      skip(`${L.name} won ${rec.won} of their last ${rec.won + rec.lost} settled parlays (needs ≥ ${P.min_leader_parlay_wins})`);
      continue;
    }
    if (openParlays(ctx.ledger).length >= P.max_open && P.action === "paper") {
      skip(`already ${P.max_open} open parlays (max_open)`);
      continue;
    }
    const combo = await ctx.freshMarket("kalshi", bet.kalshiTicker).catch(() => null);
    const raw = combo?.raw as { mve_selected_legs?: KalshiComboLeg[] } | undefined;
    const sel = (raw?.mve_selected_legs ?? []).filter((l): l is Required<KalshiComboLeg> => !!l.market_ticker && (l.side === "yes" || l.side === "no"));
    if (!combo) {
      later();
      continue;
    }
    title = combo.title || title;
    if (sel.length < 2) {
      skip("couldn't read the parlay's legs");
      continue;
    }
    const legs: ParlayLegRecord[] = [];
    const checks: Check[] = [{ stage: "filters", name: "Leader", ok: true, detail: leaderLine(L, ctx.cfg) }];
    let bad: string | undefined;
    let unreadable = false;
    let feeMarket: NormalizedMarket | undefined;
    for (const [i, l] of sel.entries()) {
      const side = l.side as SignalSide;
      const m = await ctx.freshMarket("kalshi", l.market_ticker).catch(() => null);
      if (!m) {
        unreadable = true;
        break;
      }
      const settled = settlementPrice(m, side);
      if (settled != null) {
        if (settled < 1) {
          bad = `leg ${m.title} already lost`;
          break;
        }
        legs.push({ platform: "kalshi", marketId: m.id, side, title: m.title, url: m.url, game: gameKey(m), entryPrice: 1, status: "won", settledAt: ctx.now.toISOString() });
        checks.push({ stage: "filters", name: `Leg ${i + 1}`, ok: true, detail: `${side.toUpperCase()} ${m.title} — already won` });
        continue;
      }
      if ((m.status ?? "open") !== "open" || !canTrade(m, side, "buy")) {
        bad = `leg ${m.title} can't be bought right now`;
        break;
      }
      const px = buyPrice(m, side);
      if (px < P.min_leg_price - 1e-9) {
        bad = `leg ${side.toUpperCase()} ${m.title} is ${cents(px)} (needs ≥ ${cents(P.min_leg_price)})`;
        break;
      }
      feeMarket ??= m;
      legs.push({ platform: "kalshi", marketId: m.id, side, title: m.title, url: m.url, game: gameKey(m), entryPrice: px, status: "open", lastPrice: sellPrice(m, side) });
      checks.push({ stage: "filters", name: `Leg ${i + 1}`, ok: true, detail: `${side.toUpperCase()} ${m.title} at ${cents(px)}` });
    }
    if (unreadable) {
      later();
      continue;
    }
    // One game in two parlays means one result sinks both.
    const busy = new Set([...openParlays(ctx.ledger).flatMap((p) => p.legs.filter((l) => l.status === "open" && l.game).map((l) => l.game!)), ...suggested]);
    const clash = legs.find((l) => l.status === "open" && l.game && busy.has(l.game));
    if (!bad && clash) bad = `${clash.title} is already in another open parlay`;
    if (bad || !feeMarket) {
      skip(bad ?? "every leg has already settled", sel.length);
      continue;
    }
    const price = parlayPrice(legs.filter((l) => l.status === "open").map((l) => l.entryPrice), P.combo_margin);
    const maxPrice = bet.price * (1 + P.max_chase_pct);
    checks.push({
      stage: "signal",
      name: "Parlay price",
      ok: price <= maxPrice + 1e-9,
      detail: `${cents(price)} now (legs multiplied + ${Math.round(P.combo_margin * 100)}% cut) vs the leader's ${cents(bet.price)} (max ${cents(maxPrice)})`,
    });
    if (price > maxPrice + 1e-9) {
      skip(`costs ${cents(price)} now vs the leader's ${cents(bet.price)}`, sel.length);
      continue;
    }
    const ok = await place(
      ctx,
      state,
      {
        source: "leader",
        platform: "kalshi",
        legs,
        price,
        leader: { name: L.name, wallet: L.wallet, ticker: bet.kalshiTicker, price: bet.price, usd: Math.round(bet.usd), at: new Date(bet.at * 1000).toISOString() },
      },
      checks,
      feeMarket,
      { kind: "leader", title: combo.title, leader: L.name, usd: Math.round(bet.usd) },
    );
    if (ok) {
      made += 1;
      for (const l of legs) if (l.game) suggested.add(l.game);
    }
  }
  const maxAge = ctx.cfg.copy.max_trade_age_minutes * 60;
  state.parlayPending = retry.filter((b, i) => nowSec - b.at <= maxAge && retry.findIndex((x) => x.leader.wallet === b.leader.wallet && x.kalshiTicker === b.kalshiTicker) === i);
  return made;
}

/**
 * Settle open parlays leg by leg (full checks only). One lost leg loses it; when every leg has
 * won or is void, it pays stake / price, with void legs taken out of the price.
 */
export async function settleParlays(
  ledger: PaperLedger,
  lookup: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null | undefined>,
  now: Date,
  push: (e: EngineEvent) => Promise<void>,
): Promise<{ closed: number; realizedPnlUsd: number }> {
  let closed = 0;
  let realized = 0;
  for (const p of openParlays(ledger)) {
    for (const leg of p.legs) {
      if (leg.status !== "open") continue;
      const m = await lookup(leg.platform, leg.marketId).catch(() => null);
      if (!m) continue;
      const s = settlementPrice(m, leg.side);
      if (s != null) {
        leg.status = s >= 1 - 1e-9 ? "won" : s <= 1e-9 ? "lost" : "void";
        leg.settledAt = now.toISOString();
        leg.lastPrice = s;
      } else if ((m.status ?? "open") === "open") {
        leg.lastPrice = canTrade(m, leg.side, "sell") ? sellPrice(m, leg.side) : leg.side === "yes" ? m.yesPrice : 1 - m.yesPrice;
      }
    }
    const contracts = p.stakeUsd / p.price;
    const voidFactor = p.legs.filter((l) => l.status === "void").reduce((a, l) => a * l.entryPrice, 1);
    p.markValueUsd = round2(contracts * voidFactor * p.legs.reduce((a, l) => a * (l.status === "won" ? 1 : l.status === "lost" ? 0 : l.status === "void" ? 1 : l.lastPrice ?? l.entryPrice), 1));
    const lost = p.legs.find((l) => l.status === "lost");
    const done = p.legs.every((l) => l.status !== "open");
    if (!lost && !done) continue;
    let pnl: number;
    if (lost) {
      p.status = "lost";
      pnl = -p.stakeUsd - p.feeUsd;
    } else if (p.legs.every((l) => l.status === "void")) {
      p.status = "void";
      pnl = 0;
    } else {
      p.status = "won";
      pnl = contracts * voidFactor - p.stakeUsd - p.feeUsd;
    }
    p.realizedPnlUsd = round2(pnl);
    p.markValueUsd = p.status === "won" ? round2(contracts * voidFactor) : p.status === "void" ? p.stakeUsd : 0;
    p.closedAt = now.toISOString();
    closed += 1;
    realized += pnl;
    const wonLegs = p.legs.filter((l) => l.status === "won").length;
    await push({
      at: now.toISOString(),
      type: "paper_exit",
      ruleId: p.ruleId,
      message:
        p.status === "lost"
          ? `Paper parlay LOST (${wonLegs}/${p.legs.length} legs won; ${lost!.side.toUpperCase()} ${lost!.title} lost) PnL ${money(pnl)}`
          : p.status === "void"
            ? `Paper parlay void (every leg was cancelled); stake back`
            : `Paper parlay WON (${wonLegs}/${p.legs.length} legs) PnL ${money(pnl)}`,
      sizeUsd: p.stakeUsd,
      data: { parlayId: p.id, pnlUsd: round2(pnl), status: p.status },
    });
  }
  return { closed, realizedPnlUsd: round2(realized) };
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
