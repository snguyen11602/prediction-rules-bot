import { test } from "node:test";
import assert from "node:assert/strict";
import type { NormalizedMarket } from "../types.js";
import { findExactPairs, kalshiTickersForRace, matchElections, matchGames, parseGameEvent, parseUsRace } from "./exact-pairs.js";
import { discoverBaskets } from "./arb.js";
import { needsConfirming } from "./arb-runtime.js";
import { ArbitrageSchema, RuleSchema } from "../rules/schema.js";
import { applyOutcome, checkEntryRisk, defaultRiskState } from "./risk.js";

const k = (ticker: string, city: string, bid: number, ask: number): NormalizedMarket => ({
  platform: "kalshi",
  id: ticker,
  title: `${city} wins`,
  yesPrice: (bid + ask) / 2,
  yesBid: bid,
  yesAsk: ask,
  eventId: ticker.slice(0, ticker.lastIndexOf("-")),
  raw: { yes_sub_title: city },
});

const usGame = (slug: string, long: [string, string], short: [string, string], over: Record<string, unknown> = {}): NormalizedMarket => ({
  platform: "polymarket_us",
  id: slug.length.toString() + slug.slice(-2),
  title: `${long[1]} vs ${short[1]}`,
  yesPrice: 0.47,
  yesBid: 0.46,
  yesAsk: 0.47,
  outcomes: [long[1], short[1]],
  raw: {
    slug,
    sportsMarketTypeV2: "SPORTS_MARKET_TYPE_MONEYLINE",
    marketSides: [
      { long: true, team: { abbreviation: long[0], name: long[1] } },
      { long: false, team: { abbreviation: short[0], name: short[1] } },
    ],
    ...over,
  },
});

const PHI = k("KXNBAGAME-26NOV04PHIDET-PHI", "Philadelphia", 0.47, 0.48);
const DET = k("KXNBAGAME-26NOV04PHIDET-DET", "Detroit", 0.52, 0.53);

test("a game matches by league, date and both teams, picking the Kalshi team that is YES on Polymarket US", () => {
  assert.deepEqual(parseGameEvent("KXMLBGAME-26OCT232000TBMIL"), { series: "KXMLBGAME", date: "2026-10-23", teams: "TBMIL" });
  // Polymarket US lists Detroit as YES here: the pair must use Kalshi's Detroit market.
  const us = usGame("aec-nba-det-phi-2026-11-04", ["det", "Detroit Pistons"], ["phi", "Philadelphia 76ers"]);
  const [p, ...rest] = matchGames([PHI, DET], [us]);
  assert.equal(rest.length, 0);
  assert.equal(p.kalshi.id, DET.id);
  assert.equal(p.kind, "game");
  assert.match(p.how, /Detroit Pistons vs Philadelphia 76ers on 2026-11-04/);
});

test("games that don't line up exactly are left alone", () => {
  const good = (): NormalizedMarket => usGame("aec-nba-phi-det-2026-11-04", ["phi", "Philadelphia 76ers"], ["det", "Detroit Pistons"]);
  assert.equal(matchGames([PHI, DET], [good()]).length, 1);
  // Abbreviations agree but a name doesn't: no pair.
  assert.equal(matchGames([PHI, DET], [usGame("aec-nba-phi-det-2026-11-04", ["phi", "Phoenix Suns"], ["det", "Detroit Pistons"])]).length, 0);
  // Not the moneyline (a spread on the same game).
  assert.equal(matchGames([PHI, DET], [usGame("aec-nba-phi-det-2026-11-04", ["phi", "Philadelphia 76ers"], ["det", "Detroit Pistons"], { sportsMarketTypeV2: "SPORTS_MARKET_TYPE_SPREAD" })]).length, 0);
  // A different date.
  assert.equal(matchGames([PHI, DET], [usGame("aec-nba-phi-det-2026-11-05", ["phi", "Philadelphia 76ers"], ["det", "Detroit Pistons"])]).length, 0);
  // Soccer-style events with a draw market, and the NFL (ties), aren't matched.
  const tie = k("KXNBAGAME-26NOV04PHIDET-TIE", "Tie", 0.1, 0.12);
  assert.equal(matchGames([PHI, DET, tie], [good()]).length, 0);
  const nfl = [k("KXNFLGAME-26NOV08LVSF-LV", "Las Vegas", 0.2, 0.21), k("KXNFLGAME-26NOV08LVSF-SF", "San Francisco", 0.79, 0.8)];
  assert.equal(matchGames(nfl, [usGame("aec-nfl-lv-sf-2026-11-08", ["lv", "Las Vegas Raiders"], ["sf", "San Francisco 49ers"])]).length, 0);
});

const race = (slug: string, question: string, description: string): NormalizedMarket => ({
  platform: "polymarket_us",
  id: `r-${slug}`,
  title: question,
  yesPrice: 0.27,
  yesBid: 0.26,
  yesAsk: 0.27,
  raw: { slug, question, description },
});
const kRace = (ticker: string, title: string, sub: string): NormalizedMarket => ({ platform: "kalshi", id: ticker, title, subtitle: sub, yesPrice: 0.27, yesBid: 0.26, yesAsk: 0.27 });

test("election races map office, state, district, year and party, and check the wording on both sides", () => {
  assert.deepEqual(parseUsRace("ewc-usse-tx-2026-11-03-rep"), { office: "senate", state: "tx", district: undefined, year: 2026, party: "R" });
  assert.deepEqual(kalshiTickersForRace(parseUsRace("ushrewc-ushr-oh-01-2026-11-03-dem")!), ["HOUSEOH1-26-D", "HOUSEOH01-26-D"]);
  assert.deepEqual(kalshiTickersForRace(parseUsRace("usgubewc-usgub-fl-2026-11-03-rep")!), ["GOVPARTYFL-26-R"]);
  assert.equal(parseUsRace("ewc-usp-2028-11-07-rep"), null, "not a race we know how to map");

  const us = race("ewc-usse-tx-2026-11-03-rep", "Texas Senate Election Winner", "This market will settle to Yes if the Republican Party nominee wins the 2026 midterm election for US Senator from Texas.");
  const kal = kRace("SENATETX-26-R", "Will Republicans win the Senate race in Texas?", "Ken Paxton");
  const [p] = matchElections([us], [kal]);
  assert.equal(p.kind, "election");
  assert.match(p.how, /Texas senate 2026, Republican/);
  // The other party's Kalshi market never matches.
  assert.equal(matchElections([us], [kRace("SENATETX-26-R", "Will Democrats win the Senate race in Texas?", "James Talarico")]).length, 0);
  // Wording that disagrees (a state legislature race, a different year) doesn't match either.
  assert.equal(matchElections([race("ewc-usse-tx-2026-11-03-rep", "Texas Senate Election Winner", "Republican nominee wins the 2028 state election")], [kal]).length, 0);
});

test("exact game pairs trade like confirmed ones; election races alert until you confirm them", async () => {
  const us = usGame("aec-nba-phi-det-2026-11-04", ["phi", "Philadelphia 76ers"], ["det", "Detroit Pistons"]);
  const elec = race("ewc-usse-tx-2026-11-03-rep", "Texas Senate Election Winner", "Republican Party nominee wins the 2026 midterm election for US Senator from Texas.");
  const kal = kRace("SENATETX-26-R", "Will Republicans win the Senate race in Texas?", "Ken Paxton");
  const exact = await findExactPairs(
    {
      kalshiSeries: async (s) => (s === "KXNBAGAME" ? [PHI, DET] : []),
      kalshiTickers: async (t) => (t.includes("SENATETX-26-R") ? [kal] : []),
      usSlugs: async (slugs) => (slugs.includes("aec-nba-phi-det-2026-11-04") ? [us] : []),
    },
    [elec],
    0,
  );
  assert.deepEqual(exact.map((e) => e.kind).sort(), ["election", "game"]);
  const cfg = ArbitrageSchema.parse({});
  const d = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [], exact });
  const by = (m: string) => d.baskets.filter((b) => b.matchedBy === m);
  assert.equal(by("exact").length, 2, "both directions of the game");
  assert.equal(by("election").length, 2);
  assert.ok(by("exact").every((b) => b.how && /same game/.test(b.how)));
  assert.equal(needsConfirming("exact"), false);
  assert.equal(needsConfirming("election"), true);
  assert.equal(needsConfirming("auto"), true);
  // A blocked pair stays blocked.
  const d2 = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [{ kalshi: PHI.id, polymarket: us.id, platform: "polymarket_us" }] }, markets: [], eventGroups: [], exact });
  assert.equal(d2.baskets.filter((b) => b.matchedBy === "exact").length, 0);
});

test("fire_after_n_losses: 0 never pauses, and an old pause no longer blocks", () => {
  const rule = RuleSchema.parse({ id: "c", name: "c", risk: { fire_after_n_losses: 0 } });
  let state: ReturnType<typeof defaultRiskState> = { ...defaultRiskState("2026-11-03"), pausedUntil: "2099-01-01T00:00:00Z" };
  assert.equal(checkEntryRisk(rule, state).ok, true);
  for (let i = 0; i < 10; i++) state = applyOutcome(rule, { ...state, openPositions: 1 }, -5).state;
  assert.equal(state.pausedUntil, "2099-01-01T00:00:00Z", "no new pause is set");
  assert.equal(checkEntryRisk(rule, state).checks[0].detail, "never pauses after losses (fire_after_n_losses: 0)");
  // Other rules still pause as before.
  const normal = RuleSchema.parse({ id: "n", name: "n", risk: { fire_after_n_losses: 2 } });
  let s2 = defaultRiskState("2026-11-03");
  s2 = applyOutcome(normal, { ...s2, openPositions: 1 }, -1).state;
  s2 = applyOutcome(normal, { ...s2, openPositions: 1 }, -1).state;
  assert.ok(s2.pausedUntil);
  assert.equal(checkEntryRisk(normal, s2).ok, false);
});
