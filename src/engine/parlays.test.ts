import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopyTradingSchema } from "../rules/schema.js";
import type { NormalizedMarket } from "../types.js";
import type { KalshiRankRow, KalshiSocialTrade } from "../platforms/kalshi-social.js";
import { DemoAdapter } from "../platforms/demo.js";
import { kalshiFills, pickKalshiLeaders, pollKalshiLeaders, type CopyState, type Leader } from "./copy.js";
import type { CopyDeps } from "./copy-runtime.js";
import { gameKey, legCandidates, parlayPrice } from "./parlays.js";
import { runPaperCycle } from "./paper-session.js";
import { summarizeLedger, type PaperLedger } from "../ledger/paper.js";

const T0 = new Date("2026-11-03T20:00:00Z");
const iso = (d: Date, minAgo = 0) => new Date(d.getTime() - minAgo * 60_000).toISOString();
let tid = 0;
const trade = (nick: string, ticker: string, side: "yes" | "no", yesPrice: number, count: number, at: string, action: "buy" | "sell" = "buy", maker = false): KalshiSocialTrade => ({
  trade_id: `t${++tid}`,
  ticker,
  price_dollars: yesPrice.toFixed(4),
  count_fp: count.toFixed(2),
  taker_side: side,
  taker_action: action,
  taker_nickname: maker ? "someone" : nick,
  maker_nickname: maker ? nick : "",
  create_date: at,
});

test("Kalshi fills: only trades the leader took, priced on their side (a NO taker pays 1 − YES price)", () => {
  const fills = kalshiFills("ace", [
    trade("ace", "KXATPMATCH-26NOV03RUUJOD-JOD", "no", 0.64, 1000, iso(T0)),
    trade("ace", "KXATPMATCH-26NOV03RUUJOD-JOD", "yes", 0.64, 50, iso(T0), "buy", true),
  ]);
  assert.equal(fills.length, 1, "resting orders that got hit (maker fills) are left out");
  assert.equal(fills[0].outcome, "No");
  assert.ok(Math.abs(fills[0].price - 0.36) < 1e-9);
  assert.equal(fills[0].slug, "KXATPMATCH-26NOV03RUUJOD-JOD");
});

function fakeSocial(people: Record<string, { pnl: number; lifetime: number; markets: number; visible: boolean }>, trades: KalshiSocialTrade[]): NonNullable<CopyDeps["kalshiSocial"]> {
  return {
    leaderboard: async () => Object.entries(people).map(([nickname, p], i): KalshiRankRow => ({ nickname, value: p.pnl, rank: i + 1 })),
    metrics: async (n) => (people[n] ? { pnlUsd: people[n].lifetime, markets: people[n].markets } : null),
    trades: async (n) => (people[n]?.visible ? { visible: true, trades: trades.filter((t) => t.taker_nickname === n || t.maker_nickname === n).sort((a, b) => b.create_date.localeCompare(a.create_date)) } : { visible: false, trades: [] }),
  };
}

test("Kalshi leaders: public trades, profit this month AND over their whole account; parlay record from their combos", async () => {
  const cfg = CopyTradingSchema.parse({});
  const social = fakeSocial(
    {
      ace: { pnl: 80_000, lifetime: 400_000, markets: 900, visible: true },
      private: { pnl: 200_000, lifetime: 900_000, markets: 900, visible: false },
      lucky: { pnl: 60_000, lifetime: -50_000, markets: 900, visible: true },
      newbie: { pnl: 30_000, lifetime: 30_000, markets: 12, visible: true },
    },
    [
      trade("ace", "KXMVECROSSCATEGORY-A-1", "yes", 0.3, 1000, iso(T0, 3000)),
      trade("ace", "KXMVECROSSCATEGORY-A-2", "yes", 0.25, 1000, iso(T0, 2000)),
      trade("ace", "KXMVECROSSCATEGORY-A-3", "yes", 0.2, 1000, iso(T0, 1000)),
    ],
  );
  const results: Record<string, "won" | "lost" | "open"> = { "KXMVECROSSCATEGORY-A-1": "won", "KXMVECROSSCATEGORY-A-2": "lost", "KXMVECROSSCATEGORY-A-3": "open" };
  const r = await pickKalshiLeaders(social, cfg, async (t) => results[t] ?? null);
  assert.equal(r.considered, 4);
  assert.equal(r.hidden, 1, "private traders can't be copied");
  assert.deepEqual(r.list.map((l) => l.name), ["ace"], "a losing account and a tiny one are left out");
  assert.equal(r.list[0].wallet, "kalshi:ace");
  assert.equal(r.list[0].source, "kalshi");
  assert.deepEqual(r.list[0].parlays, { won: 1, lost: 1, open: 1 });
});

test("polling Kalshi leaders: bets combined, re-reads skipped, sells and opposite buys close a copy", async () => {
  const cfg = CopyTradingSchema.parse({});
  const leader: Leader = { source: "kalshi", wallet: "kalshi:ace", name: "ace", windowPnlUsd: 1, markets: 1, decided: 0, wins: 0, winRate: 0 };
  const trades = [trade("ace", "KXNBAGAME-26NOV03BOSNYK-BOS", "yes", 0.7, 1000, iso(T0, 5)), trade("ace", "KXNBAGAME-26NOV03BOSNYK-BOS", "yes", 0.72, 1000, iso(T0, 4))];
  const social = fakeSocial({ ace: { pnl: 1, lifetime: 1, markets: 1, visible: true } }, trades);
  const state: CopyState = { version: 1, lastSeen: {}, seen: [], exits: {}, recent: [] };
  const bets = await pollKalshiLeaders(social, [{ leader }], state, cfg, T0);
  assert.equal(bets.length, 1);
  assert.equal(bets[0].kalshiTicker, "KXNBAGAME-26NOV03BOSNYK-BOS");
  assert.ok(Math.abs(bets[0].price - 0.71) < 1e-9);
  assert.equal((await pollKalshiLeaders(social, [{ leader }], state, cfg, new Date(T0.getTime() + 60_000))).length, 0);
  // Buying NO on the same market nets their YES out: that's a sell for our copy.
  trades.push(trade("ace", "KXNBAGAME-26NOV03BOSNYK-BOS", "no", 0.8, 3000, iso(T0, -2)));
  await pollKalshiLeaders(social, [{ leader }], state, cfg, new Date(T0.getTime() + 180_000));
  assert.ok(state.exits["kalshi:ace|KXNBAGAME-26NOV03BOSNYK-BOS|Yes"]);
});

test("parlay price: the legs multiplied plus the market makers' cut; one leg per game", () => {
  assert.ok(Math.abs(parlayPrice([0.8, 0.75, 0.9, 0.72], 0.05) - 0.8 * 0.75 * 0.9 * 0.72 * 1.05) < 1e-12);
  assert.equal(parlayPrice([0.99, 0.99], 0.5), 0.99, "never $1 or more");
  assert.equal(gameKey({ platform: "kalshi", id: "KXNBAGAME-26NOV03BOSNYK-BOS", eventId: "KXNBAGAME-26NOV03BOSNYK" }), "kalshi:KXNBAGAME-26NOV03BOSNYK");
  assert.equal(gameKey({ platform: "polymarket_us", id: "9", raw: { slug: "aec-nba-bos-nyk-2026-11-03" } }), gameKey({ platform: "polymarket_us", id: "10", raw: { slug: "asc-nba-bos-nyk-2026-11-03" } }));
  const cfg = CopyTradingSchema.parse({}).parlays;
  const leg = (key: string, game: string, backingUsd: number) => ({ key, platform: "kalshi" as const, marketId: key, side: "yes" as const, title: key, game, backingUsd, leaders: ["a"], leaderPrice: 0.8, firstAt: iso(T0), lastAt: iso(T0) });
  const picked = legCandidates([leg("a1", "g1", 5000), leg("a2", "g1", 9000), leg("b", "g2", 2000), leg("c", "g3", 500), leg("d", "g4", 3000)], cfg, "kalshi", new Set(["g4"]));
  assert.deepEqual(picked.map((l) => l.key), ["a2", "b"], "best-backed per game; small backing and busy games left out");
});

const km = (ticker: string, bid: number, ask: number, extra: Partial<NormalizedMarket> = {}): NormalizedMarket & { closesInHours: number } => ({
  platform: "kalshi",
  id: ticker,
  title: ticker,
  eventId: ticker.slice(0, ticker.lastIndexOf("-")),
  yesPrice: (bid + ask) / 2,
  yesBid: bid,
  yesAsk: ask,
  closesInHours: 6,
  ...extra,
});

async function setup(rulesExtra = "", people?: Record<string, { pnl: number; lifetime: number; markets: number; visible: boolean }>) {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-parlay-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: noop
    name: noop
    filters: { keywords_any: [zzzz] }
copy_trading:
  copy: { venues: [kalshi] }
${rulesExtra}`,
  );
  const fixture = path.join(dir, "k.json");
  let markets: Array<NormalizedMarket & { closesInHours?: number }> = [];
  const write = async (ms: Array<NormalizedMarket & { closesInHours?: number }>) => {
    markets = ms;
    await writeFile(fixture, JSON.stringify(ms));
  };
  const trades: KalshiSocialTrade[] = [];
  const social = fakeSocial(people ?? { ace: { pnl: 80_000, lifetime: 400_000, markets: 900, visible: true }, bob: { pnl: 50_000, lifetime: 100_000, markets: 500, visible: true } }, trades);
  const deps: CopyDeps = {
    data: { leaderboard: async () => [], userStats: async () => null, closedPositions: async () => [], trades: async () => [] },
    globalBySlug: async () => [],
    usBySlug: async () => [],
    kalshiSocial: social,
    kalshiMarket: async (t) => markets.find((m) => m.id === t) ?? null,
  };
  const ledgerPath = path.join(dir, "ledger.json");
  const run = (now: Date) =>
    runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, copyDeps: deps, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })] });
  const ledger = async () => JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  return { dir, write, trades, run, ledger };
}

test("paper copy: a Kalshi leader's bet is copied on the same Kalshi market, and sold when they sell", async () => {
  const s = await setup();
  const T = "KXNBAGAME-26NOV03BOSNYK-BOS";
  await s.write([km(T, 0.7, 0.71)]);
  s.trades.push(trade("ace", T, "yes", 0.7, 2000, iso(T0, 3)));
  const r1 = await s.run(T0);
  assert.equal(r1.opened, 1);
  const pos = (await s.ledger()).positions[0];
  assert.equal(pos.platform, "kalshi");
  assert.equal(pos.marketId, T);
  assert.equal(pos.side, "yes");
  assert.equal(pos.copiedFrom?.wallet, "kalshi:ace");
  assert.match(pos.entryTrace?.[0].detail ?? "", /ace \(Kalshi\).*all-time/);
  assert.ok(r1.copy?.leaders.some((l) => l.source === "kalshi" && l.name === "ace"));
  s.trades.push(trade("ace", T, "yes", 0.78, 2000, iso(T0, -5), "sell"));
  const r2 = await s.run(new Date(T0.getTime() + 600_000));
  assert.equal(r2.closed, 1);
  assert.equal((await s.ledger()).positions[0].exitReason, "leader_sold");
});

test("copies never pay more than 95¢", async () => {
  const s = await setup();
  const T = "KXITFMATCH-26NOV03BENARE-ARE";
  await s.write([km(T, 0.96, 0.97)]);
  s.trades.push(trade("ace", T, "yes", 0.97, 3000, iso(T0, 3)));
  const r = await s.run(T0);
  assert.equal(r.opened, 0);
  assert.match(r.copy?.recent[0].reason ?? "", /above its 95¢ limit/);
});

test("built parlay: 70%+ legs the leaders bet big on, one per game, priced as the legs multiplied + cut; settled leg by leg", async () => {
  const s = await setup("  parlays: { legs: 3, min_leg_backing_usd: 1000, stake_usd: 10 }\n");
  const games = ["KXNBAGAME-26NOV03BOSNYK-BOS", "KXNHLGAME-26NOV03TORMTL-TOR", "KXNBAGAME-26NOV03LALGSW-GSW", "KXNBAGAME-26NOV03BOSNYK-NYK", "KXNBAGAME-26NOV03MIAORL-MIA"];
  await s.write([km(games[0], 0.8, 0.81), km(games[1], 0.74, 0.75), km(games[2], 0.9, 0.91), km(games[3], 0.19, 0.2), km(games[4], 0.55, 0.56)]);
  s.trades.push(
    trade("ace", games[0], "yes", 0.8, 3000, iso(T0, 2)), // $2,400
    trade("bob", games[1], "yes", 0.74, 2000, iso(T0, 2)), // $1,480
    trade("ace", games[2], "yes", 0.9, 1500, iso(T0, 2)), // $1,350
    trade("bob", games[3], "no", 0.2, 1000, iso(T0, 2)), // same game as games[0] (and $800): never with it
    trade("ace", games[4], "yes", 0.55, 4000, iso(T0, 2)), // 56¢: under 70¢
  );
  const r = await s.run(T0);
  assert.equal(r.parlays?.opened, 1);
  const led = await s.ledger();
  const [p] = Object.values(led.parlays ?? {});
  assert.equal(p.source, "built");
  assert.equal(p.platform, "kalshi");
  assert.deepEqual(p.legs.map((l) => l.marketId).sort(), [games[0], games[1], games[2]].sort());
  const product = 0.81 * 0.75 * 0.91;
  assert.ok(Math.abs(p.price - product * 1.05) < 1e-9);
  assert.ok(Math.abs(p.payoutUsd - Math.round((10 / p.price) * 100) / 100) < 1e-9);
  assert.ok(r.copy?.parlays?.pool.some((l) => l.marketId === games[4]), "the 56¢ leg waits in the pool");
  // No second parlay out of the same legs.
  assert.equal((await s.run(new Date(T0.getTime() + 60_000))).parlays?.opened ?? 0, 0);

  // Two legs win, one is still playing.
  const res = (m: NormalizedMarket & { closesInHours: number }, out: "yes" | "no") => ({ ...m, status: "resolved" as const, resolvedOutcome: out, yesBid: undefined, yesAsk: undefined, yesPrice: out === "yes" ? 1 : 0 });
  await s.write([res(km(games[0], 0.8, 0.81), "yes"), res(km(games[1], 0.74, 0.75), "yes"), km(games[2], 0.95, 0.96)]);
  const r2 = await s.run(new Date(T0.getTime() + 3 * 3600_000));
  assert.equal(r2.parlays?.closed, 0);
  const mid = Object.values((await s.ledger()).parlays ?? {})[0];
  assert.deepEqual(mid.legs.map((l) => l.status), ["won", "won", "open"]);
  assert.ok((mid.markValueUsd ?? 0) > 10, "worth more than the stake with two legs in");
  await s.write([res(km(games[0], 0.8, 0.81), "yes"), res(km(games[1], 0.74, 0.75), "yes"), res(km(games[2], 0.95, 0.96), "yes")]);
  const r3 = await s.run(new Date(T0.getTime() + 6 * 3600_000));
  assert.equal(r3.parlays?.closed, 1);
  const done = Object.values((await s.ledger()).parlays ?? {})[0];
  assert.equal(done.status, "won");
  assert.ok(Math.abs((done.realizedPnlUsd ?? 0) - Math.round((10 / done.price - 10 - done.feeUsd) * 100) / 100) < 0.011);
  const sum = summarizeLedger(await s.ledger()).rules.find((x) => x.ruleId === "copy-parlays");
  assert.equal(sum?.wins, 1);
  assert.equal(sum?.closed, 1);
});

test("one lost leg loses the parlay; a void leg drops out and the payout shrinks", async () => {
  const s = await setup("  parlays: { legs: 2, min_leg_backing_usd: 1000, stake_usd: 10 }\n");
  const a = "KXNBAGAME-26NOV03BOSNYK-BOS";
  const b = "KXNHLGAME-26NOV03TORMTL-TOR";
  await s.write([km(a, 0.79, 0.8), km(b, 0.74, 0.75)]);
  s.trades.push(trade("ace", a, "yes", 0.8, 3000, iso(T0, 2)), trade("bob", b, "yes", 0.75, 3000, iso(T0, 2)));
  assert.equal((await s.run(T0)).parlays?.opened, 1);
  await s.write([
    { ...km(a, 0.79, 0.8), status: "resolved", resolvedOutcome: "yes", yesBid: undefined, yesAsk: undefined, yesPrice: 1 },
    { ...km(b, 0.74, 0.75), status: "resolved", settlementYesPrice: 0.5, yesBid: undefined, yesAsk: undefined, yesPrice: 0.5 },
  ]);
  await s.run(new Date(T0.getTime() + 3600_000));
  const p = Object.values((await s.ledger()).parlays ?? {})[0];
  assert.equal(p.status, "won");
  assert.deepEqual(p.legs.map((l) => l.status), ["won", "void"]);
  // Without the void leg the parlay is just the first leg: stake / (price / 0.75).
  assert.ok(Math.abs((p.realizedPnlUsd ?? 0) - Math.round(((10 / p.price) * 0.75 - 10 - p.feeUsd) * 100) / 100) < 0.011);

  const s2 = await setup("  parlays: { legs: 2, min_leg_backing_usd: 1000, stake_usd: 10 }\n");
  await s2.write([km(a, 0.79, 0.8), km(b, 0.74, 0.75)]);
  s2.trades.push(trade("ace", a, "yes", 0.8, 3000, iso(T0, 2)), trade("bob", b, "yes", 0.75, 3000, iso(T0, 2)));
  await s2.run(T0);
  await s2.write([km(a, 0.85, 0.86), { ...km(b, 0.74, 0.75), status: "resolved", resolvedOutcome: "no", yesBid: undefined, yesAsk: undefined, yesPrice: 0 }]);
  const r = await s2.run(new Date(T0.getTime() + 3600_000));
  assert.equal(r.parlays?.closed, 1, "lost as soon as one leg loses, without waiting for the rest");
  const lost = Object.values((await s2.ledger()).parlays ?? {})[0];
  assert.equal(lost.status, "lost");
  assert.ok(Math.abs((lost.realizedPnlUsd ?? 0) + 10 + lost.feeUsd) < 0.011);
});

test("a Kalshi leader's own parlay is copied when they bet big, have won parlays before and every leg is 70%+", async () => {
  const legs = [km("KXNBAGAME-26NOV03BOSNYK-BOS", 0.79, 0.8), km("KXNCAAMBGAME-26NOV03FLAMIA-FLA", 0.84, 0.85)];
  const combo = (ticker: string, l: NormalizedMarket[]) =>
    km(ticker, 0, 1, { yesBid: undefined, yesAsk: undefined, yesPrice: 0.7, title: "yes Boston,yes Florida", raw: { mve_selected_legs: l.map((m) => ({ market_ticker: m.id, side: "yes" })) } });
  const pastWin = km("KXMVECROSSCATEGORY-OLD-1", 0, 1, { status: "resolved", resolvedOutcome: "yes", yesBid: undefined, yesAsk: undefined, yesPrice: 1 });
  const s = await setup("  parlays: { min_leader_parlay_usd: 250, min_leader_parlay_wins: 1 }\n");
  await s.write([...legs, combo("KXMVECROSSCATEGORY-NEW-1", legs), pastWin]);
  s.trades.push(trade("ace", pastWin.id, "yes", 0.4, 100, iso(T0, 3000)), trade("ace", "KXMVECROSSCATEGORY-NEW-1", "yes", 0.7, 1000, iso(T0, 2)));
  const r = await s.run(T0);
  assert.equal(r.opened, 0, "a parlay is not copied as a single bet");
  assert.equal(r.parlays?.opened, 1);
  const [p] = Object.values((await s.ledger()).parlays ?? {});
  assert.equal(p.source, "leader");
  assert.equal(p.leader?.name, "ace");
  assert.ok(Math.abs(p.price - 0.8 * 0.85 * 1.05) < 1e-9);
  assert.equal(p.legs.length, 2);
  assert.equal(r.copy?.parlays?.recent[0].result, "opened");

  // bob has never won a parlay: his is reported, not copied.
  const s2 = await setup("  parlays: { min_leader_parlay_usd: 250, min_leader_parlay_wins: 1 }\n");
  await s2.write([...legs, combo("KXMVECROSSCATEGORY-NEW-2", legs)]);
  s2.trades.push(trade("bob", "KXMVECROSSCATEGORY-NEW-2", "yes", 0.7, 1000, iso(T0, 2)));
  const r2 = await s2.run(T0);
  assert.equal(r2.parlays?.opened, 0);
  assert.match(r2.copy?.parlays?.recent[0].reason ?? "", /won 0 of their last 0/);

  // A leg under 70¢ keeps it out.
  const weak = [legs[0], km("KXNHLGAME-26NOV03TORMTL-TOR", 0.6, 0.61)];
  const s3 = await setup("  parlays: { min_leader_parlay_usd: 250, min_leader_parlay_wins: 1 }\n");
  await s3.write([...weak, combo("KXMVECROSSCATEGORY-NEW-3", weak), pastWin]);
  s3.trades.push(trade("ace", pastWin.id, "yes", 0.4, 100, iso(T0, 3000)), trade("ace", "KXMVECROSSCATEGORY-NEW-3", "yes", 0.5, 1000, iso(T0, 2)));
  const r3 = await s3.run(T0);
  assert.equal(r3.parlays?.opened, 0);
  assert.match(r3.copy?.parlays?.recent[0].reason ?? "", /61¢ \(needs ≥ 70¢\)/);
});

test("parlays in alert mode only suggest, and nothing is written to the ledger", async () => {
  const s = await setup("  parlays: { action: alert, legs: 2, min_leg_backing_usd: 1000 }\n");
  const a = "KXNBAGAME-26NOV03BOSNYK-BOS";
  const b = "KXNHLGAME-26NOV03TORMTL-TOR";
  await s.write([km(a, 0.79, 0.8), km(b, 0.74, 0.75)]);
  s.trades.push(trade("ace", a, "yes", 0.8, 3000, iso(T0, 2)), trade("bob", b, "yes", 0.75, 3000, iso(T0, 2)));
  const r = await s.run(T0);
  assert.equal(Object.keys((await s.ledger()).parlays ?? {}).length, 0);
  assert.ok(r.events.some((e) => e.type === "entry_signal" && /PARLAY IDEA 2-leg/.test(e.message)));
  assert.equal(r.copy?.parlays?.recent[0].result, "alerted");
});
