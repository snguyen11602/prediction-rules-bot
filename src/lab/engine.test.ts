import { test } from "node:test";
import assert from "node:assert/strict";
import { backtest, DEFAULT_PARAMS, monteCarlo, mulberry32, pickBets, ruleBlocker, ruleFor, ruleYaml, verdictOf, type LabBet, type LabParams } from "./engine.js";
import { downloadLab, LEAGUE_LABEL, pathFromCandles, summarizeLab, type LabData, type LabMarket } from "./data.js";
import { parse as parseYaml } from "yaml";
import { RuleSchema, RulesFileSchema } from "../rules/schema.js";

const START = Date.parse("2026-11-01T00:00:00Z");
const DAY = 86_400_000;
/** A side of a game with quotes given as [hoursBefore, bid¢, ask¢]. */
const side = (game: string, name: string, won: boolean, quotes: Array<[number, number, number]>, over: Partial<LabMarket> = {}): LabMarket => ({
  t: `KXNBAGAME-${game}-${name.toUpperCase().slice(0, 3)}`, e: `KXNBAGAME-${game}`, s: "KXNBAGAME", n: name, q: `${game} winner`, r: won ? 1 : 0, st: START, p: quotes.flatMap(([h, b, a]) => [h, b * 10, a * 10]), ...over,
});
const data = (markets: LabMarket[]): LabData => ({ version: 1, fetchedAt: "2026-11-09T00:00:00Z", markets });
const P = (over: Partial<LabParams> = {}): LabParams => ({ ...DEFAULT_PARAMS, minPrice: 0, maxPrice: 1, ...over });

const G1 = [side("G1", "Boston", true, [[12, 68, 70], [1, 74, 76]]), side("G1", "New York", false, [[12, 30, 32], [1, 24, 26]])];
const G2 = [side("G2", "Denver", false, [[12, 60, 62], [1, 60, 62]], { st: START + DAY }), side("G2", "Utah", true, [[12, 38, 40], [1, 38, 40]], { st: START + DAY })];

test("picking: one side per game by rule, in the price range, from a trustworthy quote", () => {
  const d = data([...G1, ...G2]);
  assert.deepEqual(pickBets(d, P({ pick: "favorite" })).map((b) => b.side), ["Boston", "Denver"]);
  assert.deepEqual(pickBets(d, P({ pick: "underdog" })).map((b) => b.side), ["New York", "Utah"]);
  // Boston rose 6¢ (69 → 75); New York fell 6¢; game 2 didn't move.
  const risers = pickBets(d, P({ pick: "riser", minMove: 0.02 }));
  assert.deepEqual(risers.map((b) => [b.side, +b.move!.toFixed(2)]), [["Boston", 0.06]]);
  assert.deepEqual(pickBets(d, P({ pick: "faller", minMove: 0.02 })).map((b) => b.side), ["New York"]);
  // The favorite must itself be in the range (not "the best side that happens to fit").
  assert.deepEqual(pickBets(d, P({ pick: "favorite", minPrice: 0.3, maxPrice: 0.7 })).map((b) => b.side), ["Denver"]);
  assert.equal(pickBets(d, P({ pick: "all", minPrice: 0.2, maxPrice: 0.45 })).length, 2, "every side in the range");
  // Filters: league, dates, a wide book, a missing hour.
  assert.equal(pickBets(d, P({ leagues: ["KXNFLGAME"] })).length, 0);
  assert.deepEqual(pickBets(d, P({ from: START + DAY / 2 })).map((b) => b.side), ["Denver"]);
  assert.equal(pickBets(data([side("G3", "Wide", true, [[1, 40, 60]])]), P()).length, 0);
  assert.equal(pickBets(d, P({ entryH: 6 })).length, 0);
  // One side has no usable quote: the side that's left isn't "the favorite" or "the underdog"
  // unless its own price settles it (50¢ or more can only be the favorite).
  const lone = (cents: number) => data([side("G4", "Left", true, [[1, cents - 1, cents + 1]]), side("G4", "Unquoted", false, [[1, 20, 60]])]);
  assert.equal(pickBets(lone(30), P({ pick: "favorite" })).length, 0);
  assert.equal(pickBets(lone(30), P({ pick: "underdog" })).length, 0);
  assert.equal(pickBets(lone(70), P({ pick: "underdog" })).length, 0);
  assert.deepEqual(pickBets(lone(70), P({ pick: "favorite" })).map((b) => b.side), ["Left"]);
  assert.equal(pickBets(lone(30), P({ pick: "all" })).length, 1, "'every side' doesn't compare sides, so it still counts");
});

test("a bet's return: the ask and taker fee, or the bid and maker fee; selling before the game pays the bid", () => {
  const d = data(G1);
  const [taker] = pickBets(d, P());
  // Buy at 76¢, fee 0.07 × 0.76 × 0.24 = 1.28¢, wins $1: (1 − 0.76 − 0.01277) / 0.76.
  assert.equal(+taker.ret.toFixed(4), 0.299);
  const [maker] = pickBets(d, P({ exec: "maker" }));
  assert.equal(maker.price, 0.74);
  assert.equal(+maker.ret.toFixed(4), +((1 - 0.74 - 0.0175 * 0.74 * 0.26) / 0.74).toFixed(4));
  // Buy 12h before at 70¢, sell 1h before at the 74¢ bid, a fee each way.
  const [swing] = pickBets(d, P({ entryH: 12, exit: "pregame", exitH: 1 }));
  assert.equal(swing.exitValue, 0.74);
  assert.equal(+swing.ret.toFixed(4), +((0.74 - 0.07 * 0.74 * 0.26 - 0.7 - 0.07 * 0.7 * 0.3) / 0.7).toFixed(4));
  assert.equal(swing.rode, undefined);
  // No quote at the exit hour: it rides to the result, and says so.
  const [held] = pickBets(d, P({ entryH: 12, exit: "pregame", exitH: 6 }));
  assert.deepEqual([held.exitValue, held.rode], [1, true]);
});

const bet = (ret: number, i: number, over: Partial<LabBet> = {}): LabBet => ({ ticker: `T${i}`, series: i % 2 ? "KXNBAGAME" : "KXNFLGAME", side: "x", game: "g", start: START + i * DAY, price: 0.8, mid: 0.79, won: ret > 0, exitValue: ret > 0 ? 1 : 0, ret, ...over });

test("backtest: flat and percent staking, drawdown, streaks, and the breakdowns add up", () => {
  const bets = [0.25, -1, -1, 0.25, 0.25].map((r, i) => bet(r, i));
  const flat = backtest(bets, { stake: "flat", size: 100, pct: 0, bankroll: 1000 });
  assert.deepEqual(flat.trades.map((t) => t.pnl), [25, -100, -100, 25, 25]);
  assert.equal(flat.stats.pnl, -125);
  assert.equal(flat.stats.maxDrawdown, 200);
  assert.equal(+flat.stats.maxDrawdownPct.toFixed(4), +(200 / 1025).toFixed(4));
  assert.equal(flat.stats.longestLosing, 2);
  assert.deepEqual([flat.stats.bets, flat.stats.wins, flat.stats.days], [5, 3, 5]);
  assert.equal(+flat.stats.profitFactor.toFixed(3), 0.375);
  assert.equal(flat.byLeague.reduce((a, s) => a + s.pnl, 0), -125);
  assert.equal(flat.byMonth.length, 1);
  assert.equal(flat.byPrice[0].label, "80–90¢");
  // 10% of the bankroll each time compounds.
  const pct = backtest(bets, { stake: "percent", size: 0, pct: 0.1, bankroll: 1000 });
  assert.equal(+pct.trades[1].stake.toFixed(2), 102.5);
  assert.equal(+pct.stats.endBankroll.toFixed(2), +(1000 * 1.025 * 0.9 * 0.9 * 1.025 * 1.025).toFixed(2));
  // A bankroll that runs out is reported, but every bet is still measured at its full size.
  const bust = backtest([bet(-1, 0), bet(-1, 1), bet(0.25, 2)], { stake: "flat", size: 600, pct: 0, bankroll: 1000 });
  assert.deepEqual([bust.stats.bustAt, bust.stats.bets, bust.stats.endBankroll, bust.stats.lowest], [START + DAY, 3, -50, -1200]);
  assert.equal(bust.stats.maxDrawdownPct, 1, "never more than everything");
  assert.equal(flat.stats.bustAt, undefined);
  // A share of the bankroll can shrink it but never empty it.
  const shrink = backtest([bet(-1, 0), bet(-1, 1), bet(-1, 2)], { stake: "percent", size: 0, pct: 0.5, bankroll: 1000 });
  assert.deepEqual([shrink.stats.endBankroll, shrink.stats.bustAt], [125, undefined]);
  assert.equal(backtest([], { stake: "flat", size: 50, pct: 0, bankroll: 1000 }).verdict, "no bets matched");
});

test("verdict: nothing is called real without 100 bets and two standard errors", () => {
  assert.equal(verdictOf(40, 0.2, 0.01), "too few bets to say");
  assert.equal(verdictOf(400, 0.02, 0.02), "ahead, but within luck");
  assert.equal(verdictOf(400, -0.02, 0.02), "behind, but within luck");
  assert.equal(verdictOf(400, 0.06, 0.02), "made money, and unlikely to be luck");
  assert.equal(verdictOf(400, -0.2, 0.05), "lost money, and unlikely to be luck");
});

test("Monte Carlo: seeded, ordered percentiles, and honest about sure things and coin flips", () => {
  const o = { runs: 2000, horizon: 100, stake: "flat" as const, size: 50, pct: 0, bankroll: 1000, ruinAt: 0.5, seed: 7 };
  // A bet that always pays 10%: every future ends at exactly +$500.
  const sure = monteCarlo([0.1], o)!;
  assert.deepEqual([sure.profitChance, sure.ruinChance, +sure.final.p5.toFixed(6), +sure.final.p95.toFixed(6), sure.drawdown.p95], [1, 0, 500, 500, 0]);
  // A fair coin at even money: about half the futures profit, and the middle one is near zero.
  const coin = monteCarlo([1, -1], o)!;
  assert.ok(coin.profitChance > 0.4 && coin.profitChance < 0.56, String(coin.profitChance));
  assert.ok(Math.abs(coin.final.p50) <= 100);
  assert.ok(coin.final.p5 < coin.final.p25 && coin.final.p25 <= coin.final.p50 && coin.final.p50 <= coin.final.p75 && coin.final.p75 < coin.final.p95);
  assert.ok(coin.ruinChance > 0.2, "50 a bet on a coin flip with $1,000 often loses half");
  assert.equal(coin.bands.x.length, 60);
  assert.equal(coin.bands.x.at(-1), 100);
  assert.equal(+coin.bands.p50.at(-1)!.toFixed(6), +coin.final.p50.toFixed(6));
  assert.equal(coin.hist.counts.reduce((a, b) => a + b, 0), 2000);
  assert.equal(coin.samples.length, 12);
  // Same seed, same simulation; another seed, another one.
  assert.deepEqual(monteCarlo([1, -1], o)!.final, coin.final);
  assert.notDeepEqual(monteCarlo([1, -1], { ...o, seed: 8 })!.final, coin.final);
  assert.equal(monteCarlo([], o), null);
  const r = mulberry32(1);
  assert.ok([r(), r(), r()].every((x) => x >= 0 && x < 1));
  // Percent staking can't go below zero.
  const pctRun = monteCarlo([1, -1], { ...o, stake: "percent", pct: 0.5 })!;
  assert.ok(pctRun.final.min >= -1000);
});

test("a tested idea becomes a paper rule when the bot is able to run it", () => {
  // The strategy from the lab: NBA + La Liga favorites at 75–100¢, three hours before the start, $500 from $5,000.
  const { rule, notes } = ruleFor(P({ pick: "favorite", minPrice: 0.75, maxPrice: 1, entryH: 3, leagues: ["KXNBAGAME", "KXLALIGAGAME"], bankroll: 5000, size: 500 }))!;
  assert.match(rule.id, /^lab-favorite-75-100-[a-z0-9]{6}$/);
  assert.equal(rule.name, "Lab favorites 75–100¢, La Liga + NBA");
  assert.deepEqual(rule.filters, {
    platforms: ["kalshi"], market_types: ["game_winner"], leagues: ["laliga", "nba"], min_price: 0.75, max_price: 1, max_spread: 0.05,
    pre_game_only: true, min_hours_to_start: 2.5, max_hours_to_start: 3.5,
  });
  // A rule's buy limit has to stay under $1 (a 100¢ top once produced a rule the bot refused to load).
  assert.deepEqual(rule.entry, { side: "yes", yes_price_above: 0.75, max_buy_price: 0.99 });
  assert.equal(RuleSchema.parse(rule).entry.max_buy_price, 0.99);
  // The range is on the mid, like the test: the buy may cost half the spread more, plus slippage.
  assert.equal(ruleFor(P({ pick: "favorite", minPrice: 0.85, maxPrice: 0.95 }))!.rule.entry.max_buy_price, 0.98);
  // $500 a bet from $5,000, and as many open at once as that bankroll covers (the test has no other cap).
  assert.deepEqual(rule.risk, { bankroll_usd: 5000, position_size_fraction: 0.1, max_position_usd: 500, max_open_positions: 10, fire_after_n_losses: 0 });
  assert.deepEqual(notes, ["Paper fills add half a cent of slippage to every buy, which the test doesn't."]);

  const riser = ruleFor(P({ pick: "riser", entryH: 1, fromH: 12, minMove: 0.02 }))!.rule;
  assert.deepEqual(riser.entry.pregame_move, { min_move: 0.02, lookback_hours: 11, max_hours_to_start: 1.5 });
  assert.equal(riser.entry.yes_price_above, undefined);
  const every = ruleFor(P({ pick: "all", minPrice: 0.2, maxPrice: 0.4 }))!.rule;
  assert.deepEqual([every.name, every.filters.min_price, every.entry.yes_price_above], ["Lab every side 20–40¢", 0.2, 0.2]);

  // The id names which bets are picked, not the money: a new bet size is the same strategy…
  const base = P({ pick: "favorite", minPrice: 0.85, maxPrice: 0.95 });
  const id = (over: Partial<LabParams>) => ruleFor({ ...base, ...over })!.rule.id;
  assert.equal(id({ size: 100, bankroll: 9000 }), id({}));
  assert.equal(id({ stake: "percent", pct: 0.05 }), id({}));
  assert.equal(id({ from: 1, to: 2 }), id({}), "the dates of the test don't change the strategy");
  // …and anything that changes the bets is a different one.
  const others = [{ entryH: 3 }, { leagues: ["KXNBAGAME"] }, { leagues: ["KXNHLGAME"] }, { maxSpread: 0.03 }, { maxPrice: 0.9 }, { pick: "all" as const }];
  assert.equal(new Set([id({}), ...others.map(id)]).size, others.length + 1);
  assert.equal(id({ leagues: ["KXNHLGAME", "KXNBAGAME"] }), id({ leagues: ["KXNBAGAME", "KXNHLGAME"] }), "league order doesn't matter");

  // Percent bets: the bot sizes on the starting bankroll, and says so.
  const pct = ruleFor(P({ minPrice: 0.85, maxPrice: 0.95, stake: "percent", pct: 0.05, bankroll: 2000 }))!;
  assert.deepEqual([pct.rule.risk.position_size_fraction, pct.rule.risk.max_position_usd, pct.rule.risk.max_open_positions], [0.05, 100, 20]);
  assert.match(pct.notes[0], /5% of the starting bankroll every time/);
  // A favorite is known only by its price.
  const low = ruleFor(P({ pick: "favorite", minPrice: 0.3, maxPrice: 0.7 }))!;
  assert.equal(low.rule.filters.min_price, 0.5);
  assert.match(low.notes[0], /The test started at 30¢/);

  // Every shape must load as a real rule, as data and as the text to paste.
  const shapes: Array<Partial<LabParams>> = [
    {}, { pick: "riser" }, { pick: "all" }, { pick: "favorite", minPrice: 0.3, maxPrice: 0.7, leagues: ["KXNBAGAME", "KXNHLGAME"] },
    { pick: "riser", entryH: 0, fromH: 1 }, { pick: "riser", entryH: 24, fromH: 26, minMove: 0.005 }, { stake: "percent", pct: 0.05, entryH: 6 },
    { size: 5000, bankroll: 100 }, { stake: "percent", pct: 1 }, { entryH: 0 }, { leagues: Object.keys(LEAGUE_LABEL) }, { maxPrice: 1, size: 100_000, bankroll: 10_000_000 },
  ];
  for (const over of shapes) {
    const p = P({ minPrice: 0.6, maxPrice: 0.9, ...over });
    const made = ruleFor(p)!;
    assert.deepEqual(RuleSchema.parse(made.rule).filters, made.rule.filters, JSON.stringify(over));
    const text = ruleYaml(p)!;
    const file = RulesFileSchema.parse(parseYaml(`version: 1\nrules:\n${text}\n`));
    assert.deepEqual([file.rules.length, file.rules[0].action, file.rules[0].id], [1, "paper", made.rule.id], text);
    assert.equal(text.split("\n").filter((l) => l.startsWith("  # ")).length, made.notes.length, "each difference from the test is a comment in the text");
  }

  // What the bot can't run gets no rule, and a plain reason instead.
  for (const [over, why] of [
    [{ exec: "maker" }, /can't leave an order resting/], [{ exit: "pregame" }, /can't sell at a set time/], [{ pick: "underdog" }, /can't tell which side is the underdog/],
    [{ pick: "faller" }, /no rule for buying the side whose price fell/], [{ pick: "favorite", minPrice: 0.2, maxPrice: 0.4 }, /50¢ or more/],
  ] as Array<[Partial<LabParams>, RegExp]>) {
    assert.equal(ruleFor(P(over)), null);
    assert.equal(ruleYaml(P(over)), null);
    assert.match(ruleBlocker(P(over))!, why);
  }
  assert.equal(ruleBlocker(P({})), null);
  assert.equal(Object.keys(LEAGUE_LABEL).length, 11, "every game series has a league name");
});

test("dataset: candles become hourly quotes; an update only fetches games that aren't on disk", async () => {
  const start = Date.parse("2026-11-05T00:00:00Z");
  const c = (hBefore: number, bid: string, ask: string) => ({ end_period_ts: (start - hBefore * 3600_000) / 1000, yes_bid: { close_dollars: bid }, yes_ask: { close_dollars: ask } });
  assert.deepEqual(pathFromCandles([c(1, "0.60", "0.62"), c(12, "0.55", "0.585"), c(3, "0.00", "1.00"), c(-1, "0.9", "0.92"), c(30, "0.5", "0.52")], start), [12, 550, 585, 1, 600, 620]);

  const calls: string[] = [];
  const raw = (ticker: string, result: string, day: string) => ({ ticker, event_ticker: ticker.slice(0, ticker.lastIndexOf("-")), result, title: "A vs B", yes_sub_title: ticker.slice(-3), expected_expiration_time: `${day}T03:00:00Z`, latest_expiration_time: `${day.slice(0, 8)}${String(Number(day.slice(8)) + 2).padStart(2, "0")}T00:00:00Z` });
  const listing = [raw("KXNBAGAME-26NOV06AAABBB-AAA", "yes", "2026-11-06"), raw("KXNBAGAME-26NOV06AAABBB-BBB", "no", "2026-11-06"), raw("KXNBAGAME-26NOV04CCCDDD-CCC", "yes", "2026-11-04")];
  const get = async <T,>(url: URL): Promise<T> => {
    calls.push(url.pathname.split("/").pop()! + (url.searchParams.get("market_tickers") ? `:${url.searchParams.get("market_tickers")}` : ""));
    if (url.pathname.endsWith("/candlesticks")) {
      const tickers = url.searchParams.get("market_tickers")!.split(",");
      return { markets: tickers.map((t) => ({ market_ticker: t, candlesticks: [{ end_period_ts: Date.parse("2026-11-05T23:00:00Z") / 1000, yes_bid: { close_dollars: "0.60" }, yes_ask: { close_dollars: "0.62" } }] })) } as T;
    }
    return { markets: listing } as T;
  };
  const now = new Date("2026-11-09T00:00:00Z");
  const have = data([side("X", "old", true, [[1, 50, 52]], { t: "KXNBAGAME-26NOV04CCCDDD-CCC", st: Date.parse("2026-11-04T00:00:00Z") })]);
  const d = await downloadLab({ existing: have, now, get, pauseMs: 0, series: ["KXNBAGAME"] });
  assert.deepEqual(d.markets.map((m) => m.t), ["KXNBAGAME-26NOV04CCCDDD-CCC", "KXNBAGAME-26NOV06AAABBB-AAA", "KXNBAGAME-26NOV06AAABBB-BBB"]);
  assert.deepEqual(calls, ["markets", "candlesticks:KXNBAGAME-26NOV06AAABBB-AAA,KXNBAGAME-26NOV06AAABBB-BBB"], "the game already on disk isn't asked for again");
  assert.deepEqual(d.markets[1].p, [1, 600, 620]);
  assert.deepEqual([d.markets[1].r, d.markets[2].r, d.markets[1].n], [1, 0, "AAA"]);
  const sum = summarizeLab(d);
  assert.deepEqual([sum.markets, sum.games, sum.leagues[0].label], [3, 2, "NBA"]);
  // Games older than the window are dropped.
  assert.equal((await downloadLab({ existing: have, now, get, pauseMs: 0, series: ["KXNBAGAME"], days: 4 })).markets.length, 2);
});
