import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { KalshiAdapter, kalshiLeague, kalshiTimes, normalizeKalshi } from "../platforms/kalshi.js";
import { isUsGameWinner, usLeague, usTimes } from "../platforms/polymarket-us.js";
import { CopyTradingSchema, LeagueSchema, RuleSchema } from "../rules/schema.js";
import { filterChecks, hasStarted, hoursToResolve } from "./evaluate.js";
import { evaluateExit } from "./exits.js";
import { eventKeyOf, runPaperCycle, sameGame } from "./paper-session.js";
import { DemoAdapter } from "../platforms/demo.js";
import type { NormalizedMarket } from "../types.js";
import type { PaperLedger } from "../ledger/paper.js";
import { gateCheck } from "../league/league.js";
import { leagueGuards, rookieRule } from "../league/genome.js";
import { statsFromTrades, type TradeResult } from "../league/metrics.js";
import { copyChecks, type LeaderBet } from "./copy.js";

const NOW = new Date("2026-11-04T20:00:00Z");

test("Kalshi timing: the real start and expected result, not the two-days-later placeholder close", () => {
  const game = { ticker: "KXNBAGAME-26NOV08PHICHI-PHI", close_time: "2026-11-10T20:30:00Z", latest_expiration_time: "2026-11-10T20:30:00Z", expected_expiration_time: "2026-11-08T23:30:00Z" };
  assert.deepEqual(kalshiTimes(game), { resolvesAt: "2026-11-08T23:30:00.000Z", startsAt: "2026-11-08T20:30:00.000Z" });
  // Not a sports ticker: no start guessed.
  assert.equal(kalshiTimes({ ticker: "KXHIGHNY-26NOV03-B60", latest_expiration_time: "2026-11-05T00:00:00Z", expected_expiration_time: "2026-11-04T05:00:00Z" }).startsAt, undefined);
  // Baseball, tennis and some soccer use a different latest expiry: the start is the expected result − 3h.
  assert.equal(kalshiTimes({ ticker: "KXMLBGAME-26OCT282000MILTB-TB", latest_expiration_time: "2026-11-01T00:00:00Z", expected_expiration_time: "2026-10-29T03:00:00Z" }).startsAt, "2026-10-29T00:00:00.000Z");
  assert.equal(kalshiTimes({ ticker: "KXATPMATCH-26NOV09BORSAM-SAM", latest_expiration_time: "2026-11-23T18:10:00Z", expected_expiration_time: "2026-11-09T21:10:00Z" }).startsAt, "2026-11-09T18:10:00.000Z");
  const m = normalizeKalshi({ ...game, status: "active", yes_bid_dollars: "0.60", yes_ask_dollars: "0.62" })!;
  assert.equal(m.marketType, "game_winner");
  assert.equal(normalizeKalshi({ ...game, ticker: "KXNBASPREAD-26NOV08PHICHI-PHI5", status: "active", yes_bid_dollars: "0.4", yes_ask_dollars: "0.42" })!.marketType, "other");
  // A game in progress was seen as "46h to resolve"; now it's the hours to the expected result.
  const during = new Date("2026-11-08T21:30:00Z");
  assert.equal(Math.round(hoursToResolve(m, during)!), 2);
  assert.equal(hasStarted(m, during), true);
  assert.equal(hasStarted(m, new Date("2026-11-08T18:00:00Z")), false);
});

test("Polymarket US timing and game winners", () => {
  assert.deepEqual(usTimes({ slug: "aec-nba-phi-det-2026-11-04", gameStartTime: "2026-11-04T23:00:00Z", endDate: "2026-11-18T23:00:00Z" }), { startsAt: "2026-11-04T23:00:00.000Z", resolvesAt: "2026-11-05T02:00:00.000Z" });
  // An election's "start" is election day; it doesn't resolve 3 hours later.
  assert.deepEqual(usTimes({ slug: "ewc-usse-ak-2026-11-03-rep", gameStartTime: "2026-11-03T17:00:00Z", endDate: "2026-11-10T00:00:00Z" }), { startsAt: "2026-11-03T17:00:00.000Z" });
  assert.deepEqual(usTimes({ endDate: "2026-11-18T23:00:00Z" }), {});
  assert.ok(isUsGameWinner({ slug: "aec-nba-phi-det-2026-11-04" }));
  assert.ok(!isUsGameWinner({ slug: "asc-nba-phi-det-2026-11-04" }), "a spread");
  assert.ok(isUsGameWinner({ slug: "x", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE" }));
});

const km = (over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform: "kalshi",
  id: "KXNBAGAME-26NOV04BOSNYK-BOS",
  eventId: "KXNBAGAME-26NOV04BOSNYK",
  title: "Boston wins",
  yesPrice: 0.9,
  yesBid: 0.89,
  yesAsk: 0.91,
  marketType: "game_winner",
  startsAt: "2026-11-05T00:00:00Z",
  resolvesAt: "2026-11-05T03:00:00Z",
  ...over,
});

test("pre-game and market-type filters", () => {
  const rule = RuleSchema.parse({ id: "r", name: "r", filters: { pre_game_only: true, market_types: ["game_winner"] } });
  const ok = filterChecks(rule, km(), NOW);
  assert.ok(ok.every((c) => c.ok), JSON.stringify(ok));
  assert.match(ok.find((c) => c.name === "Before the game")!.detail, /starts in 4h/);
  const live = filterChecks(rule, km({ startsAt: "2026-11-04T19:10:00Z" }), NOW).find((c) => c.name === "Before the game")!;
  assert.equal(live.ok, false);
  assert.match(live.detail, /started 50 min ago: in-play/);
  assert.equal(filterChecks(rule, km({ startsAt: "2026-11-04T20:03:00Z" }), NOW).find((c) => c.name === "Before the game")!.ok, false, "starting within 5 min counts as in-play");
  assert.equal(filterChecks(rule, km({ marketType: "other" }), NOW).find((c) => c.name === "Market type")!.ok, false);
  // No start time (not a game): passes the pre-game check.
  assert.equal(filterChecks(rule, km({ startsAt: undefined }), NOW).find((c) => c.name === "Before the game")!.ok, true);
});

test("league filter: only games in the listed leagues; a market with no league fails", () => {
  // The adapters name the league from the platforms' own ids.
  assert.equal(kalshiLeague("KXNBAGAME-26NOV04BOSNYK-BOS"), "nba");
  assert.equal(kalshiLeague("KXWNBAGAME-26SEP04LVNY-LV"), "wnba");
  assert.equal(kalshiLeague("KXLALIGAGAME-26NOV08RMABAR-RMA"), "laliga");
  assert.equal(kalshiLeague("KXNCAAMBGAME-26NOV08DUKEUNC-DUKE"), "cbb");
  assert.equal(kalshiLeague("KXNBASPREAD-26NOV04BOSNYK-BOS6"), "nba", "full-game lines belong to the league too");
  assert.equal(kalshiLeague("KXUCLTEAMTOTAL-26NOV03VILPSG-PSG2"), "ucl");
  assert.equal(kalshiLeague("KXNBAMVP-27-SGA"), undefined, "an award isn't a game");
  assert.equal(kalshiLeague("KXFEDDECISION-26DEC-C25"), undefined);
  assert.equal(usLeague("aec-nba-phi-det-2026-11-04"), "nba");
  assert.equal(usLeague("asc-nfl-buf-min-2026-11-09-neg-3pt5"), "nfl");
  assert.equal(usLeague("aec-xyz-aaa-bbb-2026-11-04"), undefined, "an unknown league code stays unknown");
  assert.equal(usLeague("will-the-fed-cut-in-december"), undefined);
  assert.equal(normalizeKalshi({ ticker: "KXNBAGAME-26NOV04BOSNYK-BOS", title: "Boston wins", yes_bid_dollars: "0.89", yes_ask_dollars: "0.91", status: "active" } as never)?.league, "nba");

  const rule = RuleSchema.parse({ id: "r", name: "r", filters: { leagues: ["nba", "laliga"] } });
  const check = (m: NormalizedMarket) => filterChecks(rule, m, NOW).find((c) => c.name === "League")!;
  assert.deepEqual([check(km({ league: "nba" })).ok, check(km({ league: "nba" })).detail], [true, "NBA"]);
  assert.equal(check(km({ league: "laliga" })).ok, true);
  const nhl = check(km({ league: "nhl" }));
  assert.deepEqual([nhl.ok, nhl.detail], [false, "NHL (needs NBA / La Liga)"]);
  const none = check(km({ league: undefined }));
  assert.deepEqual([none.ok, none.detail], [false, "not a game in a league the bot knows"]);
  // No filter: no check, and every market passes as before.
  assert.equal(filterChecks(RuleSchema.parse({ id: "r", name: "r" }), km({ league: "nhl" }), NOW).some((c) => c.name === "League"), false);
  // A league the bot doesn't know is a mistake in the rules file, not a filter that never matches.
  assert.throws(() => RuleSchema.parse({ id: "r", name: "r", filters: { leagues: ["curling"] } }));
});

test("hours-to-start filter: a window before the game, never after it starts", () => {
  // km() starts at 2026-11-05T00:00Z, four hours after NOW.
  const at = (filters: Record<string, number>, startsAt: string | undefined) =>
    filterChecks(RuleSchema.parse({ id: "r", name: "r", filters }), km({ startsAt }), NOW).find((c) => c.name === "Time to start")!;
  const window = { min_hours_to_start: 2.5, max_hours_to_start: 3.5 };
  assert.deepEqual([at(window, "2026-11-04T23:00:00Z").ok, at(window, "2026-11-04T23:00:00Z").detail], [true, "starts in 3h (needs 2.5h–3.5h before)"]);
  assert.equal(at(window, "2026-11-05T00:00:00Z").ok, false, "four hours out is too early");
  assert.equal(at(window, "2026-11-04T22:00:00Z").ok, false, "two hours out is too late");
  assert.deepEqual([at({ max_hours_to_start: 1 }, "2026-11-04T20:30:00Z").ok, at({ max_hours_to_start: 1 }, "2026-11-04T20:30:00Z").detail], [true, "starts in 30 min (needs within 1h)"]);
  const started = at({ max_hours_to_start: 1 }, "2026-11-04T19:30:00Z");
  assert.deepEqual([started.ok, started.detail], [false, "already started (needs within 1h)"]);
  assert.deepEqual([at(window, undefined).ok, at(window, undefined).detail], [false, "no start time (not a game)"]);
  assert.equal(at({ min_hours_to_start: 6 }, "2026-11-05T12:00:00Z").ok, true);
});

test("stops compare the mid, not a bid that vanished for a moment", () => {
  const exit = { stop_loss_price: 0.76 };
  const pos = { entryAt: NOW.toISOString(), entryPrice: 0.915 };
  // Gakpo: NO bid collapsed to 7.5¢ while the ask stayed at 92¢ (mid ~50¢ → still a stop), but a
  // brief dip with a sane book (bid 74¢, ask 80¢, mid 77¢) no longer sells.
  assert.equal(evaluateExit(exit, pos, km(), 0.74, NOW, 0.77), null);
  assert.equal(evaluateExit(exit, pos, km(), 0.74, NOW, 0.75)?.reason, "stop_loss");
  assert.equal(evaluateExit({ stop_loss_pct: 0.2 }, pos, km(), 0.7, NOW, 0.8), null, "−12.6% at the mid isn't −20%");
});

async function stopSetup() {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-stop-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: buyer
    name: Buyer
    action: paper
    filters: { platforms: [kalshi], keywords_any: [wins] }
    entry: { side: yes, yes_price_above: 0.5 }
    exit: { stop_loss_price: 0.5 }
    risk: { reentry_cooldown_hours: 24 }
`,
  );
  const fixture = path.join(dir, "k.json");
  const ledgerPath = path.join(dir, "ledger.json");
  const run = async (now: Date, markets: unknown[]) => {
    await writeFile(fixture, JSON.stringify(markets));
    return runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })] });
  };
  const ledger = async () => JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  return { run, ledger };
}
const mk = (id: string, bid: number, ask: number) => ({ platform: "kalshi", id, title: `${id} wins`, eventId: id.slice(0, id.lastIndexOf("-")), yesPrice: (bid + ask) / 2, yesBid: bid, yesAsk: ask, closesInHours: 30 });

test("a stop sells only if the drop is still there on a second look, and never into an empty book", async () => {
  const s = await stopSetup();
  const A = "KXNBAGAME-26NOV05BOSNYK-BOS";
  const t = (sec: number) => new Date(NOW.getTime() + sec * 1000);
  assert.equal((await s.run(t(0), [mk(A, 0.6, 0.61)])).opened, 1);
  // A dip that comes straight back: armed, then cleared, nothing sold.
  assert.equal((await s.run(t(5), [mk(A, 0.45, 0.47)])).closed, 0);
  assert.equal((await s.run(t(10), [mk(A, 0.6, 0.61)])).closed, 0);
  assert.equal((await s.ledger()).positions[0].exitPending, undefined, "the dip came back");
  // The book empties out (bid 5¢ / ask 61¢): mid 33¢ is below the stop, but it's 56¢ wide.
  const wide = await s.run(t(15), [mk(A, 0.05, 0.61)]);
  assert.equal(wide.closed, 0);
  assert.ok(wide.events.some((e) => /56¢ wide; not selling into it/.test(e.message)));
  // A real drop: fires, waits, then sells.
  assert.equal((await s.run(t(20), [mk(A, 0.44, 0.46)])).closed, 0);
  assert.equal((await s.run(t(30), [mk(A, 0.44, 0.46)])).closed, 0, "less than 20s later");
  const sold = await s.run(t(45), [mk(A, 0.43, 0.45)]);
  assert.equal(sold.closed, 1);
  const p = (await s.ledger()).positions[0];
  assert.equal(p.exitReason, "stop_loss");
  assert.match(p.exitDetail ?? "", /still there after 25s/);
  // The cooldown now covers the whole game: a sibling market of it isn't bought next.
  const sib = await s.run(t(60), [mk("KXNBAGAME-26NOV05BOSNYK-NYK", 0.6, 0.61)]);
  assert.equal(sib.opened, 0);
  assert.ok(sib.trace?.decisions.some((d) => d.checks.some((c) => /re-entry cooldown \(same game\)/.test(c.detail))));
});

const stats = (pnls: number[], at = "2026-11-01T00:00:00Z"): ReturnType<typeof statsFromTrades> =>
  statsFromTrades(
    pnls.map((p, i): TradeResult => ({ enteredAt: at, exitedAt: `2026-11-0${1 + (i % 3)}T0${i % 9}:00:00Z`, pnlUsd: p, feesUsd: 0.1 })),
    { bankrollUsd: 1000, minTrades: 5 },
  );

test("the league gate: no paper trades until a backtest made money overall and held out", () => {
  const cfg = LeagueSchema.parse({});
  assert.equal(gateCheck({ family: "favorite" }, cfg).ok, false);
  assert.match(gateCheck({ family: "favorite" }, cfg).why, /waiting for its first backtest/);
  const good = { family: "favorite" as const, backtest: { all: stats(Array(12).fill(2)), test: stats([2, 2, 2]), at: "" } };
  assert.equal(gateCheck(good, cfg).ok, true, gateCheck(good, cfg).why);
  assert.match(gateCheck({ ...good, backtest: { ...good.backtest, all: stats([2, 2, 2]) } }, cfg).why, /only 3 backtest trade/);
  assert.match(gateCheck({ ...good, backtest: { ...good.backtest, all: stats([...Array(11).fill(1), -40]) } }, cfg).why, /lost .* in its backtest/);
  assert.match(gateCheck({ ...good, backtest: { ...good.backtest, test: stats([2, -9, 2]) } }, cfg).why, /lost .* in the held-out part/);
  assert.equal(gateCheck({ family: "favorite" }, LeagueSchema.parse({ require_backtest: false })).ok, true);
});

test("league rules: game winners before the game only; favorites and long-shot fades hold to the result", () => {
  const t = { hustle: 0.5, creativity: 0.5, knowledge: 0.8 };
  let n = 0;
  const r = () => ((n = (n * 9301 + 49297) % 233280) / 233280);
  for (const fam of ["favorite", "longshot_fade"] as const) {
    const b = rookieRule(fam, t, r);
    assert.equal(b.filters.pre_game_only, true);
    assert.deepEqual(b.filters.market_types, ["game_winner"]);
    assert.equal(b.exit?.stop_loss_price, undefined);
    assert.equal(b.exit?.take_profit_price, undefined);
  }
  const old = leagueGuards({ filters: { min_price: 0.8 }, exit: { stop_loss_price: 0.7, take_profit_price: 0.99, trailing_stop: 0.02 } } as never, "longshot_fade") as { exit: Record<string, unknown> };
  assert.deepEqual(old.exit, {});
  // Your own rules' clones keep their own exits.
  assert.equal((leagueGuards({ exit: { stop_loss_price: 0.7 } } as never, "custom") as { exit: { stop_loss_price?: number } }).exit.stop_loss_price, 0.7);
});

test("one game or race on Polymarket US: both teams' or both parties' markets share an event", () => {
  const us = (slug: string, id: string): NormalizedMarket => ({ platform: "polymarket_us", id, title: slug, yesPrice: 0.5, raw: { slug } });
  assert.equal(eventKeyOf(us("ewc-usse-ia-2026-11-03-rep", "1")), eventKeyOf(us("ewc-usse-ia-2026-11-03-dem", "2")), "Iowa Senate, both parties");
  assert.notEqual(eventKeyOf(us("ewc-usse-ia-2026-11-03-rep", "1")), eventKeyOf(us("ewc-usse-tx-2026-11-03-rep", "3")));
  assert.equal(eventKeyOf(us("aec-nba-phi-det-2026-11-04", "4")), eventKeyOf(us("asc-nba-phi-det-2026-11-04", "5")), "moneyline and spread of one game");
  const held = { platform: "polymarket_us" as const, marketId: "1", eventKey: eventKeyOf(us("ewc-usse-ia-2026-11-03-rep", "1")) };
  assert.ok(sameGame(held, us("ewc-usse-ia-2026-11-03-dem", "2")));
  assert.ok(!sameGame(held, us("ewc-usse-tx-2026-11-03-rep", "3")));
  assert.equal(eventKeyOf(km()), "kalshi:26NOV04BOSNYK");
});

test("copies: only before the game, and not after the price already moved against the leader", () => {
  const cfg = CopyTradingSchema.parse({});
  const leader = { wallet: "0xa", name: "Ace", windowPnlUsd: 1, markets: 100, decided: 50, wins: 30, winRate: 0.6 };
  const bet: LeaderBet = { leader, side: "BUY", title: "Boston", outcome: "Yes", price: 0.9, shares: 1000, usd: 900, at: NOW.getTime() / 1000 - 60 };
  const names = (c: ReturnType<typeof copyChecks>) => Object.fromEntries(c.map((x) => [x.name, x.ok]));
  assert.deepEqual(names(copyChecks(bet, undefined, { market: km(), side: "yes", how: "x" }, cfg, NOW)), { Leader: true, "Leader's bet": true, "Same market": true, "Price now": true, "Not a long shot": true, "A game": true, "Before the game": true });
  // Long shots and things that aren't games (15-minute crypto, politics) aren't copied.
  const cheap = copyChecks({ ...bet, price: 0.2 }, undefined, { market: km({ yesPrice: 0.2, yesBid: 0.19, yesAsk: 0.21 }), side: "yes", how: "x" }, cfg, NOW);
  assert.equal(names(cheap)["Not a long shot"], false);
  const btc = copyChecks(bet, undefined, { market: km({ id: "KXBTC15M-26NOV091430-30", eventId: "KXBTC15M-26NOV091430", marketType: "other", startsAt: undefined }), side: "yes", how: "x" }, cfg, NOW);
  assert.equal(names(btc)["A game"], false);
  assert.equal(names(copyChecks(bet, undefined, { market: km({ id: "KXATPMATCH-26NOV04BORSAM-SAM", marketType: "other" }), side: "yes", how: "x" }, cfg, NOW))["A game"], true, "a tennis match is a game");
  assert.equal(names(copyChecks(bet, undefined, { market: km({ startsAt: "2026-11-04T19:00:00Z" }), side: "yes", how: "x" }, cfg, NOW))["Before the game"], false);
  const moved = copyChecks({ ...bet, price: 0.98 }, undefined, { market: km(), side: "yes", how: "x" }, cfg, NOW).find((c) => c.name === "Price now")!;
  assert.equal(moved.ok, false);
  assert.match(moved.detail, /moved against them/);
});

test("the Kalshi listing: upcoming games first, then established markets by volume (never the minutes-old ones)", async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(ms).toISOString();
  const game = (t: string, startH: number) => ({
    ticker: t,
    status: "active",
    yes_bid_dollars: "0.5",
    yes_ask_dollars: "0.52",
    volume_24h_fp: "10",
    latest_expiration_time: iso(now + (startH + 48) * 3600_000),
    expected_expiration_time: iso(now + (startH + 3) * 3600_000),
    close_time: iso(now + (startH + 48) * 3600_000),
  });
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x");
    seen.push(u.search);
    const series = u.searchParams.get("series_ticker");
    let markets: unknown[] = [];
    if (series === "KXNBAGAME") markets = [game("KXNBAGAME-26NOV06AAABBB-AAA", 30), game("KXNBAGAME-26NOV05CCCDDD-CCC", 5), game("KXNBAGAME-26NOV04EEEFFF-EEE", -1)];
    else if (!series) markets = [{ ...game("KXOTHER-1", 0), ticker: "KXFED-26DEC-T4", volume_24h_fp: "50000" }, { ...game("KXOTHER-2", 0), ticker: "KXCPI-26NOV-T3", volume_24h_fp: "900" }];
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ markets, cursor: "" }));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  try {
    const ad = new KalshiAdapter(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
    const list = await ad.listMarkets({ limit: 6 });
    assert.deepEqual(list.map((m) => m.id), ["KXNBAGAME-26NOV05CCCDDD-CCC", "KXNBAGAME-26NOV06AAABBB-AAA", "KXNBAGAME-26NOV04EEEFFF-EEE", "KXFED-26DEC-T4", "KXCPI-26NOV-T3"]);
    const general = seen.find((q) => !q.includes("series_ticker"))!;
    assert.match(general, /max_created_ts=\d+/, "markets listed in the last 2 hours are left out");
  } finally {
    server.close();
  }
});
