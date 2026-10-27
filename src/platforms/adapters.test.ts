import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { KalshiAdapter, kalshiTakerFeeUsd } from "./kalshi.js";
import { PolymarketAdapter } from "./polymarket.js";

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
