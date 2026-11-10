import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { KalshiAdapter, kalshiTakerFeeUsd } from "./kalshi.js";
import { PolymarketAdapter } from "./polymarket.js";
import { PolymarketUsAdapter, polymarketUsTakerFeeUsd } from "./polymarket-us.js";
import { filterChecks } from "../engine/evaluate.js";
import { RuleSchema } from "../rules/schema.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function mockFetch(routes: Record<string, { status?: number; body: unknown }>) {
  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    const hit = Object.entries(routes).find(([k]) => url.includes(k));
    if (!hit) return new Response("not found", { status: 404 });
    const [, r] = hit;
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as typeof fetch;
}

test("Kalshi: listing maps quotes; getMarket maps result to resolution", async () => {
  mockFetch({
    "/markets/SETTLED": {
      body: { market: { ticker: "SETTLED", title: "s", status: "finalized", result: "no", yes_bid_dollars: "0", yes_ask_dollars: "0" } },
    },
    "/markets/DISPUTED": {
      body: { market: { ticker: "DISPUTED", title: "d", status: "disputed", result: "yes", last_price_dollars: "0.9900" } },
    },
    "/markets/SCALAR": {
      body: { market: { ticker: "SCALAR", title: "sc", status: "finalized", result: "scalar", settlement_value_dollars: "0.3700" } },
    },
    "/markets/EMPTYBID": {
      body: { market: { ticker: "EMPTYBID", title: "e", status: "active", yes_bid_dollars: "0.0000", yes_ask_dollars: "0.9000" } },
    },
    "/markets/HALTED": {
      body: { market: { ticker: "HALTED", title: "h", status: "closed", result: "", yes_bid_dollars: "0.40", yes_ask_dollars: "0.42" } },
    },
    "/markets?": {
      body: {
        markets: [{ ticker: "OPEN1", title: "o", status: "active", yes_bid_dollars: "0.4100", yes_ask_dollars: "0.4300", close_time: "2026-11-05T00:00:00Z" }],
      },
    },
  });
  const k = new KalshiAdapter("https://kalshi.test/v2");
  const [open] = await k.listMarkets({ limit: 1 });
  assert.equal(open.status, "open");
  assert.equal(open.yesBid, 0.41);
  assert.equal(open.yesAsk, 0.43);
  assert.ok(Math.abs(open.yesPrice - 0.42) < 1e-9);

  const settled = await k.getMarket("SETTLED");
  assert.equal(settled?.status, "resolved");
  assert.equal(settled?.resolvedOutcome, "no");
  assert.equal(settled?.yesPrice, 0);

  const halted = await k.getMarket("HALTED");
  assert.equal(halted?.status, "closed");
  assert.equal(halted?.resolvedOutcome, undefined);

  assert.equal(await k.getMarket("MISSING"), null);

  assert.equal((await k.getMarket("DISPUTED"))?.status, "closed", "disputed results can still change");
  const scalar = await k.getMarket("SCALAR");
  assert.equal(scalar?.status, "resolved");
  assert.equal(scalar?.settlementYesPrice, 0.37);

  const emptyBid = await k.getMarket("EMPTYBID");
  assert.equal(emptyBid?.yesBid, undefined, "a 0 bid is an empty book, not a price");
  assert.equal(emptyBid?.yesAsk, 0.9);
  assert.equal(emptyBid?.yesPrice, 0.9);
  assert.equal(k.roundContracts(55.25), 55);
});

test("Kalshi listing: games in a league a rule is limited to are never cut off by a busy day", async () => {
  const H = 3600_000;
  const now = Date.now();
  const game = (ticker: string, startsInHours: number) => {
    const start = now + startsInHours * H;
    return {
      ticker, title: ticker, status: "active", yes_bid_dollars: "0.8000", yes_ask_dollars: "0.8200",
      expected_expiration_time: new Date(start + 3 * H).toISOString(), latest_expiration_time: new Date(start + 48 * H).toISOString(),
    };
  };
  mockFetch({
    // A college football Saturday: six games before the evening's NBA game.
    "series_ticker=KXNCAAFGAME": { body: { markets: [1, 2, 3, 4, 5, 6].map((i) => game(`KXNCAAFGAME-26NOV14TEAM${"ABCDEF"[i - 1]}OPP-TEAM${"ABCDEF"[i - 1]}`, i * 0.25)) } },
    "series_ticker=KXNBAGAME": {
      body: { markets: [game("KXNBAGAME-26NOV14LALBOS-LAL", 3), game("KXNBAGAME-26NOV14DENPHX-DEN", -1), game("KXNBAGAME-26NOV18NYKMIA-NYK", 80)] },
    },
    "max_created_ts": { body: { markets: [{ ticker: "FED-1", title: "f", status: "active", yes_bid_dollars: "0.40", yes_ask_dollars: "0.42", volume_24h_fp: "9" }, { ticker: "FED-2", title: "f", status: "active", yes_bid_dollars: "0.40", yes_ask_dollars: "0.42" }] } },
    "/markets?": { body: { markets: [] } },
  });
  const k = new KalshiAdapter("https://kalshi.test/v2");
  const plain = await k.listMarkets({ limit: 4 });
  assert.deepEqual(plain.map((m) => m.id.split("-")[0]), ["KXNCAAFGAME", "KXNCAAFGAME", "FED", "FED"], "the cap alone hides the NBA game");
  const withNba = await k.listMarkets({ limit: 4, leagues: ["nba"] });
  assert.deepEqual(withNba.slice(0, 4).map((m) => m.id), plain.map((m) => m.id), "the usual listing is unchanged");
  // …and the coming NBA game is added. Not the one in play, and not one days away.
  assert.deepEqual(withNba.slice(4).map((m) => [m.id, m.league]), [["KXNBAGAME-26NOV14LALBOS-LAL", "nba"]]);
  assert.equal((await k.listMarkets({ limit: 4, leagues: ["nhl"] })).length, 4, "a league with no games adds nothing");
  // Already inside the cap: not listed twice.
  const roomy = await k.listMarkets({ limit: 40, leagues: ["nba", "cfb"] });
  assert.equal(new Set(roomy.map((m) => m.id)).size, roomy.length);
});

test("Kalshi fee estimate rounds up to the cent and is zero at the extremes", () => {
  assert.equal(kalshiTakerFeeUsd(100, 0.5), 1.75);
  assert.equal(kalshiTakerFeeUsd(55.25, 0.905), 0.34);
  assert.equal(kalshiTakerFeeUsd(10, 1), 0);
});

test("Polymarket: bestBid/bestAsk map to quotes; closed + pinned prices resolve", async () => {
  mockFetch({
    "/markets/100": {
      body: { id: "100", question: "q", closed: true, umaResolutionStatus: "resolved", outcomePrices: '["0","1"]' },
    },
    "/markets/200": {
      body: { id: "200", question: "q2", closed: true, outcomePrices: '["0.97","0.03"]' },
    },
    "/markets/400": {
      body: { id: "400", question: "split", closed: true, umaResolutionStatus: "resolved", outcomePrices: '["0.5","0.5"]' },
    },
    "/markets?": {
      body: [
        { question: "no id", closed: false, outcomePrices: '["0.5","0.5"]' },
        { id: "500", question: "empty bid", closed: false, outcomePrices: '["0.5","0.5"]', bestBid: 0, bestAsk: 1 },
      ],
    },
    "/markets/300": {
      body: { id: "300", question: "q3", closed: false, outcomePrices: '["0.55","0.45"]', bestBid: 0.54, bestAsk: 0.56 },
    },
  });
  const p = new PolymarketAdapter("https://gamma.test");
  const resolved = await p.getMarket("100");
  assert.equal(resolved?.status, "resolved");
  assert.equal(resolved?.resolvedOutcome, "no");

  const notYet = await p.getMarket("200");
  assert.equal(notYet?.status, "closed", "closed but not pinned/resolved must not settle");

  const open = await p.getMarket("300");
  assert.equal(open?.status, "open");
  assert.equal(open?.yesBid, 0.54);
  assert.equal(open?.yesAsk, 0.56);

  const split = await p.getMarket("400");
  assert.equal(split?.status, "resolved");
  assert.equal(split?.settlementYesPrice, 0.5);
  assert.equal(split?.resolvedOutcome, undefined);

  const listed = await p.listMarkets({ limit: 5 });
  assert.deepEqual(listed.map((x) => x.id), ["500"], "markets without an id are skipped");
  assert.equal(listed[0].yesBid, undefined);
  assert.equal(listed[0].yesAsk, undefined);
});

const usd = (v: string) => ({ value: v, currency: "USD" });
const usMarket = (id: string, over: Record<string, unknown> = {}) => ({
  id,
  slug: `m-${id}`,
  question: "U.S House Midterm Winner",
  title: "Democratic Party",
  status: "MARKET_STATUS_OPEN",
  active: true,
  closed: false,
  endDate: "2027-02-02T04:59:00Z",
  category: "politics",
  feeCoefficient: 0.0695,
  minimumTradeQty: 0.01,
  marketSides: [
    { description: "Yes", long: true, price: "0.9390" },
    { description: "No", long: false, price: "0.0620" },
  ],
  bestBidQuote: usd("0.9380"),
  bestAskQuote: usd("0.9390"),
  ...over,
});

test("Polymarket US: quotes are the YES (long) side, titles say the outcome, books add liquidity", async () => {
  const now = new Date("2026-11-03T00:00:00Z");
  mockFetch({
    "/v1/markets/m-1/book": {
      body: {
        marketData: {
          bids: [{ px: usd("0.9380"), qty: "1000" }, { px: usd("0.5000"), qty: "99999" }],
          offers: [{ px: usd("0.9390"), qty: "500" }],
          stats: { lastTradePx: usd("0.9385"), lastTradeSetTime: "2026-11-02T23:59:00Z" },
        },
      },
    },
    "/v1/markets/m-2/book": {
      body: { marketData: { bids: [], offers: [], stats: { lastTradeSetTime: "2026-10-20T00:00:00Z" } } },
    },
    "/v1/markets?": {
      body: {
        markets: [
          usMarket("1"),
          usMarket("2", {
            question: "Who will win Seoul SK Knights vs Daegu Pegasus?",
            title: null,
            marketSides: [
              { description: "Seoul SK Knights", long: true },
              { description: "Daegu Pegasus", long: false },
            ],
            bestBidQuote: usd("0"),
            bestAskQuote: usd("0.55"),
          }),
          usMarket("3", { hidden: true }),
          usMarket("5", { question: "Which company will have the #1 AI model in 2026?", title: "Google" }),
          usMarket("4", { status: "MARKET_STATUS_HALTED" }),
        ],
      },
    },
  });
  const a = new PolymarketUsAdapter("https://pmus.test", { books: 10, now: () => now, pauseMs: 0 });
  const [m1, m2, m5, ...rest] = await a.listMarkets({ limit: 10 });
  assert.equal(rest.length, 0, "hidden and halted markets are left out");
  assert.equal(m5.title, "Which company will have the #1 AI model in 2026? — Google", "a shared question keeps its outcome");

  assert.equal(m1.platform, "polymarket_us");
  assert.equal(m1.title, "U.S House Midterm Winner — Democratic Party");
  assert.equal(m1.subtitle, "Democratic Party");
  assert.equal(m1.yesBid, 0.938);
  assert.equal(m1.yesAsk, 0.939);
  assert.ok(Math.abs(m1.yesPrice - 0.9385) < 1e-9);
  assert.deepEqual(m1.outcomes, ["Yes", "No"]);
  assert.equal(m1.takerFeeRate, 0.0695);
  // Only orders within 10¢ of the mid count: 1000 × 0.938 + 500 × 0.939.
  assert.equal(m1.liquidityUsd, 1407.5);
  assert.equal(m1.lastPrice, 0.9385);
  assert.equal(m1.volume24hUsd, undefined);
  assert.equal(m1.volume24hUnavailable, true, "traded today, but the API has no 24h volume");

  assert.equal(m2.title, "Who will win Seoul SK Knights vs Daegu Pegasus? [YES = Seoul SK Knights]");
  assert.equal(m2.yesBid, undefined, "a 0 bid is an empty book side");
  assert.equal(m2.yesAsk, 0.55);
  assert.equal(m2.volume24hUsd, 0, "no trade for over a day is a known zero");
  assert.equal(m2.volume24hUnavailable, undefined);

  // The 24h-volume filter is skipped (and says so) only when the platform can't say.
  const rule = RuleSchema.parse({ id: "r", name: "r", filters: { min_volume_24h_usd: 1000 } });
  const v1 = filterChecks(rule, m1, now).find((c) => c.name === "24h volume")!;
  assert.equal(v1.ok, true);
  assert.match(v1.detail, /skipped: Polymarket US doesn't publish 24h volume/);
  assert.equal(filterChecks(rule, m2, now).find((c) => c.name === "24h volume")!.ok, false);
});

test("Polymarket US: resolution comes from the settlement endpoint, never from prices", async () => {
  mockFetch({
    "/v1/markets/m-10/settlement": { body: { slug: "m-10", settlement: 1 } },
    "/v1/markets/m-11/settlement": { body: { slug: "m-11", settlement: 0.5 } },
    "/v1/markets/m-12/settlement": { status: 404, body: { code: 5 } },
    "/v1/market/id/10": { body: { market: usMarket("10", { status: "MARKET_STATUS_RESOLVED", bestBidQuote: null, bestAskQuote: null }) } },
    "/v1/market/id/11": { body: { market: usMarket("11", { status: "MARKET_STATUS_RESOLVED" }) } },
    "/v1/market/id/12": { body: { market: usMarket("12", { status: "MARKET_STATUS_RESOLVED" }) } },
    "/v1/market/id/13": { body: { market: usMarket("13", { status: "MARKET_STATUS_RESOLVING" }) } },
    "/v1/markets?": { body: { markets: [usMarket("13", { status: "MARKET_STATUS_RESOLVING" }), usMarket("10", { status: "MARKET_STATUS_RESOLVED" })] } },
  });
  const a = new PolymarketUsAdapter("https://pmus.test");
  const won = await a.getMarket("10");
  assert.equal(won?.status, "resolved");
  assert.equal(won?.resolvedOutcome, "yes");
  assert.equal(won?.yesPrice, 1);

  const split = await a.getMarket("11");
  assert.equal(split?.status, "resolved");
  assert.equal(split?.settlementYesPrice, 0.5);
  assert.equal(split?.resolvedOutcome, undefined);

  assert.equal((await a.getMarket("12"))?.status, "closed", "resolved without a published settlement waits");
  const resolving = await a.getMarket("13");
  assert.equal(resolving?.status, "closed");
  assert.equal(resolving?.yesBid, undefined, "no quotes once trading stops");
  assert.equal(await a.getMarket("999"), null);
  assert.equal(await a.getMarket("polymarket-global-slug"), null, "only numeric Polymarket US ids");

  const batch = await a.getMarkets(["13", "10", "10"]);
  assert.deepEqual(batch.map((m) => [m.id, m.status]), [["13", "closed"], ["10", "resolved"]]);
});

test("Polymarket US fees (Θ × C × p × (1 − p), banker's rounding) and contract steps", () => {
  // Worked examples from the Polymarket US fee schedule.
  assert.equal(polymarketUsTakerFeeUsd(1000, 0.1), 6.26);
  assert.equal(polymarketUsTakerFeeUsd(1000, 0.5), 17.38);
  assert.equal(polymarketUsTakerFeeUsd(1000, 0.5, 0.1), 25);
  assert.equal(polymarketUsTakerFeeUsd(10, 1), 0);
  const a = new PolymarketUsAdapter("https://pmus.test");
  const m = (step: number) => ({ platform: "polymarket_us" as const, id: "1", title: "t", yesPrice: 0.5, raw: { minimumTradeQty: step } });
  assert.equal(a.roundContracts(52.3699, m(0.01)), 52.36);
  assert.equal(a.roundContracts(52.3699, m(1)), 52);
  assert.equal(a.roundContracts(52.3699), 52, "unknown step → whole contracts");
});
