import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CopyTradingSchema } from "../rules/schema.js";
import type { NormalizedMarket } from "../types.js";
import type { TraderTrade } from "../platforms/polymarket-data.js";
import { DemoAdapter } from "../platforms/demo.js";
import { matchGame, matchTitle, pickLeaders, pollLeaders, usGameSlugs, type CopyState, type Leader } from "./copy.js";
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
  const state: CopyState = { version: 1, lastSeen: {}, recent: [] };
  const bets = await pollLeaders(fakeData(trades) as never, [leader], state, cfg, T0);
  assert.equal(bets.length, 1, "the 2-hour-old fill is too old to copy");
  assert.ok(Math.abs(bets[0].price - 0.23) < 1e-9, "size-weighted average price");
  assert.equal(bets[0].usd, 1000 * 0.2 + 3000 * 0.24);
  assert.equal(state.lastSeen[w], sec(T0) - 200);
  assert.equal((await pollLeaders(fakeData(trades) as never, [leader], state, cfg, new Date(T0.getTime() + 60_000))).length, 0);
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
  assert.deepEqual(pos.entryTrace?.map((c) => c.name).slice(0, 5), ["Leader", "Leader's bet", "Same market", "Price now", "Prices agree"]);

  // The leader sells → we sell on the next check.
  trades.push({ ...trades[0], side: "SELL", price: 0.3, timestamp: sec(T0) + 400 });
  const r2 = await run(new Date(T0.getTime() + 600_000));
  assert.equal(r2.closed, 1);
  ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.equal(ledger.positions[0].exitReason, "leader_sold");
  assert.match(ledger.positions[0].exitDetail ?? "", /sold Pacers/);
});
