import { test } from "node:test";
import assert from "node:assert/strict";
import { clearLineCache, findExactPairs, gameTwins, lineSlugs, matchLines } from "./exact-pairs.js";
import { crossBaskets } from "./arb.js";
import type { NormalizedMarket } from "../types.js";

const START = "2026-11-11T00:00:00Z";
const NOW = new Date("2026-11-10T20:00:00Z");
const kGame = (code: string, sub: string): NormalizedMarket => ({ platform: "kalshi", id: `KXNBAGAME-26NOV10OKCPOR-${code}`, eventId: "KXNBAGAME-26NOV10OKCPOR", title: `${sub} wins`, subtitle: sub, yesPrice: 0.5, yesBid: 0.49, yesAsk: 0.51, raw: { yes_sub_title: sub } });
const kSpread = (code: string, name: string, n: number, bid = 0.4, ask = 0.42): NormalizedMarket => ({
  platform: "kalshi", id: `KXNBASPREAD-26NOV10OKCPOR-${code}${Math.ceil(n)}`, eventId: "KXNBASPREAD-26NOV10OKCPOR", title: `${name} wins by over ${n} points`, yesPrice: (bid + ask) / 2, yesBid: bid, yesAsk: ask, raw: { floor_strike: n, strike_type: "greater" },
});
const kTotal = (n: number, title = `Full Game: Over ${n} points scored`): NormalizedMarket => ({
  platform: "kalshi", id: `KXNBATOTAL-26NOV10OKCPOR-${Math.ceil(n)}`, eventId: "KXNBATOTAL-26NOV10OKCPOR", title, yesPrice: 0.5, yesBid: 0.49, yesAsk: 0.51, raw: { floor_strike: n, strike_type: "greater" },
});
const team = (abbr: string, name: string) => ({ abbreviation: abbr, name });
const OKC = team("okc", "Oklahoma City Thunder");
const POR = team("por", "Portland Trail Blazers");
const uMoney: NormalizedMarket = { platform: "polymarket_us", id: "100", title: "OKC vs POR", yesPrice: 0.5, startsAt: START, raw: { slug: "aec-nba-okc-por-2026-11-10", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ long: true, team: OKC }, { long: false, team: POR }] } };
const uSpread = (slugTail: string, line: number, long: typeof OKC, type = "basketball_team_full_game_spread"): NormalizedMarket => ({
  platform: "polymarket_us", id: `s${slugTail}`, title: slugTail, yesPrice: 0.5, yesBid: 0.57, yesAsk: 0.59,
  raw: { slug: `asc-nba-okc-por-2026-11-10-${slugTail}`, line, sportsMarketType: type, sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD", marketSides: [{ long: true, team: long }, { long: false, team: long === OKC ? POR : OKC }] },
});
const uTotal = (slugTail: string, line: number, type = "basketball_team_full_game_total", over = "Over"): NormalizedMarket => ({
  platform: "polymarket_us", id: `t${slugTail}`, title: slugTail, yesPrice: 0.5, yesBid: 0.49, yesAsk: 0.51,
  raw: { slug: `tsc-nba-okc-por-2026-11-10-${slugTail}`, line, sportsMarketType: type, sportsMarketTypeV2: "SPORTS_MARKET_TYPE_TOTAL", marketSides: [{ long: true, description: over }, { long: false, description: "Under" }] },
});
const games = [kGame("OKC", "Oklahoma City"), kGame("POR", "Portland")];

test("a game on both sites: league, date and both teams by code and by name", () => {
  const [twin] = gameTwins(games, [uMoney]);
  assert.deepEqual([twin.league, twin.matchCode, twin.base, twin.startsAt], ["nba", "26NOV10OKCPOR", "nba-okc-por-2026-11-10", START]);
  assert.deepEqual(twin.teams.map((t) => t.code), ["OKC", "POR"]);
  // A code that matches but a name that doesn't (a different "POR"): no twin.
  const wrong = { ...uMoney, raw: { ...(uMoney.raw as object), marketSides: [{ long: true, team: OKC }, { long: false, team: team("por", "Porto") }] } };
  assert.equal(gameTwins(games, [wrong]).length, 0);
  // NFL games are twins for their lines even though their winners aren't arbitraged.
  const nfl = [{ ...kGame("BUF", "Buffalo"), id: "KXNFLGAME-26NOV15BUFMIN-BUF", eventId: "KXNFLGAME-26NOV15BUFMIN" }, { ...kGame("MIN", "Minnesota"), id: "KXNFLGAME-26NOV15BUFMIN-MIN", eventId: "KXNFLGAME-26NOV15BUFMIN" }];
  const um = { ...uMoney, raw: { slug: "aec-nfl-buf-min-2026-11-15", sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE", marketSides: [{ long: true, team: team("buf", "Buffalo Bills") }, { long: false, team: team("min", "Minnesota Vikings") }] } };
  assert.equal(gameTwins(nfl, [um])[0].league, "nfl");
});

test("spreads: the same team and number is the same bet; the other team getting the points is the opposite bet", () => {
  const [twin] = gameTwins(games, [uMoney]);
  const k = [kSpread("POR", "Portland", 8.5), kSpread("OKC", "Oklahoma City", 3.5)];
  assert.deepEqual(lineSlugs(twin, k).sort(), ["asc-nba-okc-por-2026-11-10-neg-3pt5", "asc-nba-okc-por-2026-11-10-neg-8pt5", "asc-nba-okc-por-2026-11-10-pos-3pt5", "asc-nba-okc-por-2026-11-10-pos-8pt5"]);
  const pairs = matchLines(twin, k, [
    uSpread("pos-8pt5", 8.5, OKC), // OKC +8.5 = Portland does NOT win by more than 8.5
    uSpread("neg-3pt5", -3.5, OKC), // OKC −3.5 = OKC wins by more than 3.5
  ]);
  assert.deepEqual(pairs.map((p) => [p.kalshi.id, p.invert ?? false]), [["KXNBASPREAD-26NOV10OKCPOR-POR9", true], ["KXNBASPREAD-26NOV10OKCPOR-OKC4", false]]);
  assert.match(pairs[0].how, /Portland Trail Blazers by more than 8\.5 .*quoted from the other side/);
  // The hedge: with an opposite pair you buy YES on both (one of them must pay); with a same pair, YES + NO.
  const inv = crossBaskets(pairs[0].kalshi, pairs[0].us, true, "exact");
  assert.deepEqual(inv[0].legs.map((l) => l.side), ["yes", "yes"]);
  const same = crossBaskets(pairs[1].kalshi, pairs[1].us, false, "exact");
  assert.deepEqual(same[0].legs.map((l) => l.side), ["yes", "no"]);
});

test("spreads and totals: anything that isn't exactly the same full-game line is left alone", () => {
  const [twin] = gameTwins(games, [uMoney]);
  const k = [kSpread("POR", "Portland", 8.5), kTotal(214.5)];
  const none = matchLines(twin, k, [
    uSpread("pos-8pt5", 8.5, POR), // the wrong team is getting the points
    uSpread("neg-8pt5", -8.5, OKC), // OKC −8.5 is a different bet from Portland by 8.5
    uSpread("pos-9pt5", 9.5, OKC), // a different number
    uSpread("fh-pos-8pt5", 8.5, OKC, "basketball_team_first_half_spread"), // first half
    uSpread("pos-8pt5", 8.5, OKC, "basketball_team_first_half_spread"), // right slug, wrong period
    uTotal("q1-214pt5", 214.5, "basketball_team_quarter_total"), // a quarter
    uTotal("tt-okc-fg-214pt5", 214.5, "basketball_team_full_game_team_total"), // one team's total
    uTotal("215pt5", 215.5), // a different number
    uTotal("214pt5", 214.5, "basketball_team_full_game_total", "Under"), // YES isn't the over
  ]);
  assert.deepEqual(none, []);
  // Whole-number lines (a push is possible) and Kalshi titles that aren't full game are never offered.
  assert.deepEqual(lineSlugs(twin, [kSpread("POR", "Portland", 8), kTotal(214.5, "First Half: Over 214.5 points scored"), kSpread("DAL", "Dallas", 8.5)]), []);
  const ok = matchLines(twin, k, [uTotal("214pt5", 214.5), uTotal("total-214pt5", 214.5)]);
  assert.equal(ok.length, 2, "both slug spellings of a full-game total");
  assert.ok(ok.every((p) => !p.invert && p.kind === "line"));
});

test("finding line pairs: a few lookups per game, cached ten minutes, prices re-read every time, only before the start", async () => {
  clearLineCache();
  const calls = { event: 0, slugs: 0, tickers: 0, series: 0 };
  const lines = [kSpread("POR", "Portland", 8.5), kSpread("POR", "Portland", 20.5, 0, 1), kTotal(214.5)];
  const us = [uMoney, uSpread("pos-8pt5", 8.5, OKC), uTotal("214pt5", 214.5)];
  const src = {
    kalshiEvent: async (e: string) => (calls.event++, lines.filter((m) => m.eventId === e)),
    kalshiSeries: async (s: string) => (calls.series++, s === "KXNBAGAME" ? games : []),
    kalshiTickers: async (ids: string[]) => (calls.tickers++, lines.filter((m) => ids.includes(m.id)).map((m) => ({ ...m, yesAsk: 0.45 }))),
    usSlugs: async (slugs: string[]) => (calls.slugs++, us.filter((m) => slugs.includes((m.raw as { slug: string }).slug))),
  };
  const first = await findExactPairs(src, [], 0, { now: NOW });
  const found = first.filter((p) => p.kind === "line");
  assert.deepEqual(found.map((p) => p.kalshi.id).sort(), ["KXNBASPREAD-26NOV10OKCPOR-POR9", "KXNBATOTAL-26NOV10OKCPOR-215"]);
  assert.equal(found[0].kalshi.yesAsk, 0.45, "prices are the fresh ones");
  assert.equal(calls.event, 2, "the game's spread event and total event");
  const eventsBefore = calls.event;
  await findExactPairs(src, [], 0, { now: new Date(NOW.getTime() + 60_000) });
  assert.equal(calls.event, eventsBefore, "the list of pairs is reused a minute later");
  // Without the option nothing about lines is looked up; after the game starts they're dropped.
  assert.equal((await findExactPairs(src, [], 0)).filter((p) => p.kind === "line").length, 0);
  assert.equal((await findExactPairs(src, [], 0, { now: new Date(Date.parse(START) + 60_000) })).filter((p) => p.kind === "line").length, 0);
});
