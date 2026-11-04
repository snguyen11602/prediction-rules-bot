import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopyTradingSchema } from "../rules/schema.js";
import type { NormalizedMarket } from "../types.js";
import type { TraderTrade } from "../platforms/polymarket-data.js";
import { DemoAdapter } from "../platforms/demo.js";
import { kalshiGameEvents, matchGame, matchKalshiGame, matchTitle, pickLeaders, pollLeaders, usGameSlugs, type CopyState, type Leader } from "./copy.js";
import type { CopyDeps } from "./copy-runtime.js";
import { runPaperCycle } from "./paper-session.js";
import type { PaperLedger } from "../ledger/paper.js";

const cfg = CopyTradingSchema.parse({});
const T0 = new Date("2026-11-02T23:00:00Z");
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

const globalGame: NormalizedMarket = {
  platform: "polymarket",
  id: "g1",
  title: "Hawks vs. Pacers",
  yesPrice: 0.795,
  yesBid: 0.79,
  yesAsk: 0.8,
  outcomes: ["Hawks", "Pacers"],
  raw: { slug: "nba-atl-ind-2026-11-02", sportsMarketType: "moneyline", gameStartTime: "2026-11-03 00:30:00+00" },
};
const usGame = (sides: [string, string], start = "2026-11-03T00:30:00Z"): NormalizedMarket => ({
  platform: "polymarket_us",
  id: "u1",
  title: "Who will win ATL Hawks vs IND Pacers? [YES = Atlanta Hawks]",
  yesPrice: 0.795,
  yesBid: 0.79,
  yesAsk: 0.8,
  outcomes: sides,
  raw: { slug: "aec-nba-atl-ind-2026-11-02", sportsMarketType: "basketball_team_full_game_winner", gameStartTime: start },
});

test("game slugs: global nba-atl-ind-DATE ↔ Polymarket US aec-nba-atl-ind-DATE (±1 day)", () => {
  assert.deepEqual(usGameSlugs("nba-atl-ind-2026-11-02"), ["aec-nba-atl-ind-2026-11-02", "aec-nba-atl-ind-2026-11-01", "aec-nba-atl-ind-2026-11-03"]);
  assert.deepEqual(usGameSlugs("will-the-democrats-win-the-maine-senate-race-in-2026"), []);
});

test("same game: the side comes from team names, never from position", () => {
  const straight = matchGame(globalGame, [usGame(["Atlanta Hawks", "Indiana Pacers"])], "Pacers");
  assert.ok("market" in straight && straight.side === "no", "Pacers is the short side → NO");
  const flipped = matchGame(globalGame, [usGame(["Indiana Pacers", "Atlanta Hawks"])], "Pacers");
  assert.ok("market" in flipped && flipped.side === "yes");
  assert.ok("reason" in matchGame(globalGame, [usGame(["Atlanta Hawks", "Indiana Pacers"], "2026-11-04T00:30:00Z")], "Pacers"), "a different day's game");
  assert.ok("reason" in matchGame(globalGame, [usGame(["Atlanta Hawks", "Boston Celtics"])], "Pacers"), "a different opponent");
  assert.ok("reason" in matchGame({ ...globalGame, raw: { ...(globalGame.raw as object), sportsMarketType: "spreads" } }, [usGame(["Atlanta Hawks", "Indiana Pacers"])], "Pacers"), "spreads are not winners");
});

test("title copies need a Yes/No bet and the strict question match", () => {
  const g: NormalizedMarket = { platform: "polymarket", id: "g2", title: "Will Marine Le Pen win the 2027 French presidential election?", yesPrice: 0.4, outcomes: ["Yes", "No"] };
  const us: NormalizedMarket = { platform: "polymarket_us", id: "u2", title: "2027 French Presidential Election Winner — Marine Le Pen", subtitle: "Marine Le Pen", yesPrice: 0.41, yesBid: 0.4, yesAsk: 0.42, outcomes: ["Yes", "No"] };
  const other: NormalizedMarket = { ...us, id: "u3", title: "2027 French Presidential Election Winner — Jordan Bardella", subtitle: "Jordan Bardella" };
  const hit = matchTitle(g, "polymarket_us", [other, us], "No", cfg);
  assert.ok("market" in hit && hit.market.id === "u2" && hit.side === "no");
  assert.ok("reason" in matchTitle(g, "polymarket_us", [other], "Yes", cfg), "a different candidate never matches");
  assert.ok("reason" in matchTitle(g, "polymarket_us", [us], "Hawks", cfg));
});

function fakeData(trades: TraderTrade[]): CopyDeps["data"] {
  const people: Record<string, { pnl: number; markets: number; wins: number; losses: number }> = {
    ["0x" + "a".repeat(40)]: { pnl: 50_000, markets: 500, wins: 70, losses: 30 },
    ["0x" + "b".repeat(40)]: { pnl: 90_000, markets: 500, wins: 40, losses: 60 },
    ["0x" + "c".repeat(40)]: { pnl: 80_000, markets: 12, wins: 50, losses: 10 },
  };
  return {
    leaderboard: async () => Object.entries(people).map(([user_id, p], i) => ({ rank: i + 1, user_id, user_name: user_id.slice(0, 3), pnl: p.pnl })),
    userStats: async (w) => ({ proxy_wallet: w, trades: people[w]?.markets ?? 0 }),
    closedPositions: async (w) => {
      const p = people[w];
      if (!p) return [];
      return [...Array(p.wins).fill({ realized_pnl: 10 }), ...Array(p.losses).fill({ realized_pnl: -10 }), { realized_pnl: 0.2 }];
    },
    trades: async (w, since) => trades.filter((t) => t.proxy_wallet === w && t.timestamp >= since),
  };
}

test("leaders: profit, enough markets and a real win rate — losers and tiny samples are left out", async () => {
  const c = CopyTradingSchema.parse({ leaders: { min_markets: 50, min_win_rate: 0.6, min_decided: 30, min_profit_usd: 10_000 } });
  const { list, considered } = await pickLeaders(fakeData([]) as never, c);
  assert.equal(considered, 3);
  assert.deepEqual(list.map((l) => l.wallet), ["0x" + "a".repeat(40)]);
  assert.equal(list[0].winRate, 0.7, "dust results (< $1) don't count");
  assert.equal(list[0].decided, 100);
});

test("polling combines a leader's fills into one bet and never re-reads old ones", async () => {
  const w = "0x" + "a".repeat(40);
  const leader: Leader = { wallet: w, name: "a", windowPnlUsd: 1, markets: 1, decided: 1, wins: 1, winRate: 1 };
  const fill = (ts: number, size: number, price: number, side: "BUY" | "SELL" = "BUY"): TraderTrade => ({
    proxy_wallet: w, side, outcome: "Pacers", outcome_index: 1, price, size, timestamp: ts, slug: "nba-atl-ind-2026-11-02", condition_id: "0xc", title: "Hawks vs. Pacers",
  });
  const trades = [fill(sec(T0) - 7200, 9999, 0.1), fill(sec(T0) - 300, 1000, 0.2), fill(sec(T0) - 200, 3000, 0.24)];
  const state: CopyState = { version: 1, lastSeen: {}, seen: [], exits: {}, recent: [] };
  const bets = await pollLeaders(fakeData(trades) as never, [{ leader }], state, cfg, T0);
  assert.equal(bets.length, 1, "the 2-hour-old fill is too old to copy");
  assert.ok(Math.abs(bets[0].price - 0.23) < 1e-9, "size-weighted average price");
  assert.equal(bets[0].usd, 1000 * 0.2 + 3000 * 0.24);
  assert.equal(state.lastSeen[w], sec(T0) - 200);
  assert.equal((await pollLeaders(fakeData(trades) as never, [{ leader }], state, cfg, new Date(T0.getTime() + 60_000))).length, 0, "overlapping re-reads are de-duplicated");
  // A late-indexed fill (older than the last one seen) is still picked up, once.
  trades.push(fill(sec(T0) - 250, 500, 0.21));
  const late = await pollLeaders(fakeData(trades) as never, [{ leader }], state, cfg, new Date(T0.getTime() + 120_000));
  assert.deepEqual(late.map((b) => b.shares), [500]);
  // Sells are remembered (no age limit), so a copy can still follow them later.
  trades.push(fill(sec(T0) + 100, 3000, 0.3, "SELL"));
  await pollLeaders(fakeData(trades) as never, [{ leader }], state, cfg, new Date(T0.getTime() + 180_000));
  assert.equal(state.exits[`${w}|0xc|Pacers`], sec(T0) + 100);
});

test("closed games are never copy targets", () => {
  assert.ok("reason" in matchGame(globalGame, [{ ...usGame(["Atlanta Hawks", "Indiana Pacers"]), status: "closed" }], "Pacers"));
  assert.ok("reason" in matchGame({ ...globalGame, raw: { ...(globalGame.raw as object), gameStartTime: undefined } }, [usGame(["Atlanta Hawks", "Indiana Pacers"])], "Pacers"), "both start times are required");
});

test("paper copy: copies the leader's game bet onto Polymarket US, and sells when the leader sells", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-copy-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: noop
    name: noop
    filters: { keywords_any: [zzzz] }
copy_trading:
  leaders: { min_markets: 50, min_win_rate: 0.6, min_decided: 30, min_profit_usd: 10000 }
`,
  );
  const fixture = path.join(dir, "m.json");
  const us = { ...usGame(["Atlanta Hawks", "Indiana Pacers"]), closesInHours: 3 };
  await writeFile(fixture, JSON.stringify([us]));
  const w = "0x" + "a".repeat(40);
  const trades: TraderTrade[] = [
    { proxy_wallet: w, side: "BUY", outcome: "Pacers", outcome_index: 1, price: 0.2, size: 5000, timestamp: sec(T0) - 300, slug: "nba-atl-ind-2026-11-02", condition_id: "0xc", title: "Hawks vs. Pacers" },
  ];
  const deps: CopyDeps = {
    data: fakeData(trades),
    globalBySlug: async () => [globalGame],
    usBySlug: async (slugs) => (slugs.includes("aec-nba-atl-ind-2026-11-02") ? [usGame(["Atlanta Hawks", "Indiana Pacers"])] : []),
  };
  const ledgerPath = path.join(dir, "ledger.json");
  const run = (now: Date) =>
    runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, copyDeps: deps, emit: () => undefined, adapters: [new DemoAdapter("polymarket_us", { fixturePath: fixture, now: () => now })] });

  const r1 = await run(T0);
  assert.equal(r1.opened, 1);
  assert.equal(r1.copy?.leaders.length, 1);
  assert.equal(r1.copy?.recent[0].result, "copied");
  let ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const pos = ledger.positions[0];
  assert.equal(pos.ruleId, "copy-leaders");
  assert.equal(pos.platform, "polymarket_us");
  assert.equal(pos.side, "no", "the leader bought Pacers = NO on 'Hawks win'");
  assert.equal(pos.copiedFrom?.wallet, w);
  assert.deepEqual(pos.entryTrace?.map((c) => c.name).slice(0, 6), ["Leader", "Leader's bet", "Same market", "Price now", "Before the game", "Prices agree"]);

  // The leader sells → we sell on the next check.
  trades.push({ ...trades[0], side: "SELL", price: 0.3, timestamp: sec(T0) + 400 });
  const r2 = await run(new Date(T0.getTime() + 600_000));
  assert.equal(r2.closed, 1);
  ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.equal(ledger.positions[0].exitReason, "leader_sold");
  assert.match(ledger.positions[0].exitDetail ?? "", /sold Pacers/);
});

/** A two-game Polymarket US fixture and a leader whose trades the test controls. */
async function copySetup(extraRules = "") {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-copy2-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: noop
    name: noop
    filters: { keywords_any: [zzzz] }
copy_trading:
  leaders: { min_markets: 50, min_win_rate: 0.6, min_decided: 30, min_profit_usd: 10000 }
${extraRules}`,
  );
  const fixture = path.join(dir, "m.json");
  const game2 = { ...usGame(["Boston Celtics", "Houston Rockets"]), id: "u2", title: "Celtics vs Rockets [YES = Boston Celtics]", raw: { slug: "aec-nba-bos-hou-2026-11-02", sportsMarketType: "basketball_team_full_game_winner", gameStartTime: "2026-11-03T01:30:00Z" } };
  const writeMarkets = (u1: Partial<NormalizedMarket>) =>
    writeFile(fixture, JSON.stringify([{ ...usGame(["Atlanta Hawks", "Indiana Pacers"]), ...u1, closesInHours: 3 }, { ...game2, closesInHours: 4 }]));
  await writeMarkets({});
  const w = "0x" + "a".repeat(40);
  const trades: TraderTrade[] = [];
  const g2: NormalizedMarket = { ...globalGame, id: "g2", title: "Celtics vs. Rockets", outcomes: ["Celtics", "Rockets"], yesPrice: 0.795, raw: { slug: "nba-bos-hou-2026-11-02", sportsMarketType: "moneyline", gameStartTime: "2026-11-03 01:30:00+00" } };
  const deps: CopyDeps = {
    data: fakeData(trades),
    globalBySlug: async (slugs) => [globalGame, g2].filter((g) => slugs.includes(String((g.raw as { slug: string }).slug))),
    usBySlug: async (slugs) => [usGame(["Atlanta Hawks", "Indiana Pacers"]), game2].filter((m) => slugs.includes(String((m.raw as { slug: string }).slug))),
  };
  const ledgerPath = path.join(dir, "ledger.json");
  const run = (now: Date) =>
    runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, copyDeps: deps, emit: () => undefined, adapters: [new DemoAdapter("polymarket_us", { fixturePath: fixture, now: () => now })] });
  const buy = (slug: string, outcome: string, at: number, side: "BUY" | "SELL" = "BUY", price = 0.2): TraderTrade => ({
    proxy_wallet: w, side, outcome, outcome_index: 1, price, size: 5000, timestamp: at, slug, condition_id: `c-${slug}`, title: slug, transaction_hash: `${slug}-${side}-${at}`,
  });
  const ledger = async () => JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  return { dir, trades, run, buy, writeMarkets, ledger, w, deps, fixture, statePath: path.join(dir, "ledger.copy.json") };
}

test("a loss pause armed by this cycle's exits blocks copies in the same cycle", async () => {
  const s = await copySetup();
  // Tighten the copy risk: one loss pauses it.
  const rulesFile = path.join(s.dir, "rules.yaml");
  await writeFile(rulesFile, (await readFile(rulesFile, "utf8")) + "  risk: { position_size_fraction: 0.03, max_position_usd: 30, fire_after_n_losses: 1, pause_hours_after_losses: 24 }\n  exit: { stop_loss_pct: 0.3 }\n");
  s.trades.push(s.buy("nba-atl-ind-2026-11-02", "Pacers", sec(T0) - 300));
  assert.equal((await s.run(T0)).opened, 1);
  // The Hawks run away with it (our NO collapses → stop loss, confirmed on the next check) while
  // the leader buys another game.
  await s.writeMarkets({ yesPrice: 0.965, yesBid: 0.96, yesAsk: 0.97 });
  const t1 = new Date(T0.getTime() + 600_000);
  assert.equal((await s.run(t1)).closed, 0, "a stop waits for a second look");
  const t2 = new Date(t1.getTime() + 60_000);
  s.trades.push(s.buy("nba-bos-hou-2026-11-02", "Rockets", sec(t2) - 30));
  const r = await s.run(t2);
  assert.equal(r.closed, 1);
  assert.equal(r.opened, 0, "the pause armed by the stop loss applies right away");
  assert.match(r.copy?.recent[0].reason ?? "", /pause|paused/i);
});

test("a leader's sell is remembered until the copy can actually sell, even after they leave the leader list", async () => {
  const s = await copySetup();
  s.trades.push(s.buy("nba-atl-ind-2026-11-02", "Pacers", sec(T0) - 300));
  assert.equal((await s.run(T0)).opened, 1);
  // They sell while nobody is bidding for our NO (no YES ask) — we can't sell yet.
  await s.writeMarkets({ yesAsk: undefined, yesBid: 0.79, yesPrice: 0.79 });
  const t1 = new Date(T0.getTime() + 300_000);
  s.trades.push(s.buy("nba-atl-ind-2026-11-02", "Pacers", sec(t1) - 30, "SELL", 0.25));
  assert.equal((await s.run(t1)).closed, 0);
  // They also drop off the leader list.
  const st = JSON.parse(await readFile(s.statePath, "utf8"));
  st.leaders.list = [];
  await writeFile(s.statePath, JSON.stringify(st));
  await s.writeMarkets({});
  const r = await s.run(new Date(T0.getTime() + 900_000));
  assert.equal(r.closed, 1);
  assert.equal((await s.ledger()).positions[0].exitReason, "leader_sold");
});

test("a buy the leader already sold again isn't copied", async () => {
  const s = await copySetup();
  s.trades.push(s.buy("nba-atl-ind-2026-11-02", "Pacers", sec(T0) - 300), s.buy("nba-atl-ind-2026-11-02", "Pacers", sec(T0) - 100, "SELL"));
  const r = await s.run(T0);
  assert.equal(r.opened, 0);
  assert.match(r.copy?.recent.find((d) => d.outcome === "Pacers")?.reason ?? "", /already sold/);
});

test("Kalshi game tickers come from the global slug (both team orders, same day or a day earlier)", () => {
  assert.deepEqual(kalshiGameEvents("nba-atl-ind-2026-11-02").map((e) => e.event), [
    "KXNBAGAME-26NOV02ATLIND",
    "KXNBAGAME-26NOV02INDATL",
    "KXNBAGAME-26NOV01ATLIND",
    "KXNBAGAME-26NOV01INDATL",
  ]);
  assert.deepEqual(kalshiGameEvents("epl-ars-che-2026-11-02"), [], "leagues without a known Kalshi series are skipped");
});

const kalshiTeam = (code: string, city: string, bid: number, ask: number): NormalizedMarket => ({
  platform: "kalshi", id: `KXNBAGAME-26NOV02ATLIND-${code}`, title: `Atlanta vs Indiana — ${city}`, subtitle: city, yesPrice: (bid + ask) / 2, yesBid: bid, yesAsk: ask,
});

test("Kalshi game: the team comes from the slug's codes and is checked against Polymarket US names", () => {
  const ks = [kalshiTeam("ATL", "Atlanta", 0.79, 0.8), kalshiTeam("IND", "Indiana", 0.2, 0.21)];
  const twin = usGame(["Atlanta Hawks", "Indiana Pacers"]);
  const hit = matchKalshiGame(globalGame, ks, ["ATL", "IND"], "Pacers", twin);
  assert.ok("market" in hit && hit.market.id.endsWith("-IND") && hit.side === "yes");
  const wrongNames = [kalshiTeam("ATL", "Indiana", 0.79, 0.8), kalshiTeam("IND", "Atlanta", 0.2, 0.21)];
  assert.ok("reason" in matchKalshiGame(globalGame, wrongNames, ["ATL", "IND"], "Pacers", twin), "names must line up");
  const coinFlip = { ...globalGame, yesPrice: 0.52 };
  assert.ok("reason" in matchKalshiGame(coinFlip, ks, ["ATL", "IND"], "Pacers"), "a close game needs the US names to confirm");
  assert.ok("market" in matchKalshiGame(globalGame, ks, ["ATL", "IND"], "Pacers"), "a lopsided game is safe without them");
});

test("copies go to Kalshi when it costs about the same, otherwise to the cheaper venue", async () => {
  const run = async (kalshiAsk: number) => {
    const s = await copySetup();
    const fixtureK = path.join(s.dir, "k.json");
    const ks = [kalshiTeam("ATL", "Atlanta", 0.79, 0.8), kalshiTeam("IND", "Indiana", kalshiAsk - 0.01, kalshiAsk)];
    await writeFile(fixtureK, JSON.stringify(ks.map((m) => ({ ...m, closesInHours: 3 }))));
    await s.writeMarkets({ takerFeeRate: 0.0695 }); // Polymarket US fees, so the comparison is like for like
    s.trades.push(s.buy("nba-atl-ind-2026-11-02", "Pacers", sec(T0) - 300));
    const r = await runPaperCycle({
      rulesPath: path.join(s.dir, "rules.yaml"),
      ledgerPath: path.join(s.dir, "ledger.json"),
      demo: true,
      now: T0,
      emit: () => undefined,
      copyDeps: { ...s.deps, kalshiEvent: async (t) => (t === "KXNBAGAME-26NOV02ATLIND" ? ks : []) },
      adapters: [new DemoAdapter("polymarket_us", { fixturePath: s.fixture, now: () => T0 }), new DemoAdapter("kalshi", { fixturePath: fixtureK, now: () => T0 })],
    });
    return { r, pos: (await s.ledger()).positions[0] };
  };
  // Polymarket US: NO on "Hawks win" costs 1 − 0.79 = 21¢ (+ slippage). Kalshi: YES on Indiana.
  const same = await run(0.21);
  assert.equal(same.pos.platform, "kalshi", "about the same → Kalshi");
  assert.equal(same.pos.side, "yes");
  assert.ok(same.pos.entryTrace?.some((c) => c.name === "Venue" && /Kalshi/.test(c.detail)));
  const dearer = await run(0.24);
  assert.equal(dearer.pos.platform, "polymarket_us", "3¢ dearer on Kalshi → the cheaper venue");
});
