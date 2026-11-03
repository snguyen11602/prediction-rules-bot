import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadHistory } from "./history.js";

const NOW = new Date("2026-10-20T00:00:00Z");
const FROM = new Date(NOW.getTime() - 4 * 86_400_000);
const s = (d: Date) => Math.floor(d.getTime() / 1000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);

const KALSHI_GAME = {
  ticker: "KXNFLGAME-26OCT19AB-A",
  event_ticker: "KXNFLGAME-26OCT19AB",
  title: "A wins",
  status: "finalized",
  result: "yes",
  open_time: hoursAgo(200).toISOString(),
  close_time: hoursAgo(20).toISOString(),
  volume_fp: "100000",
  last_price_dollars: "0.99",
};
const CANDLES = [60, 59, 58, 57, 56].map((h, i) => ({
  end_period_ts: s(hoursAgo(h)),
  yes_bid: { close_dollars: i === 4 ? "0.0000" : (0.4 + i * 0.02).toFixed(4) },
  yes_ask: { close_dollars: i === 3 ? "1.0000" : (0.42 + i * 0.02).toFixed(4) },
  volume_fp: "10",
  open_interest_fp: "500",
}));
const US_GAME = {
  id: 7,
  slug: "aec-nfl-a-b-2026-10-19",
  question: "A vs B",
  status: "MARKET_STATUS_RESOLVED",
  closed: true,
  endDate: hoursAgo(10).toISOString(),
  marketSides: [{ long: true, description: "A" }, { long: false, description: "B" }],
};
const US_FLAT = { ...US_GAME, id: 8, slug: "aec-nfl-c-d-2026-10-19" };

function fakeFetch(calls: string[]) {
  return async (input: string | URL | Request) => {
    const u = new URL(String(input));
    calls.push(u.pathname + u.search);
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (u.hostname.includes("kalshi")) {
      if (u.pathname.endsWith("/candlesticks")) return json({ candlesticks: CANDLES });
      if (u.searchParams.get("status") === "settled" && u.searchParams.get("series_ticker") === "KXNFLGAME") return json({ markets: [KALSHI_GAME] });
      return json({ markets: [] });
    }
    if (u.pathname === "/v1/markets") return json({ markets: u.searchParams.get("closed") === "true" ? [US_GAME, US_FLAT] : [] });
    if (u.pathname === "/v1/price-history") {
      const flat = u.searchParams.get("symbol") === US_FLAT.slug;
      return json({ history: [30, 29, 28, 27].map((h, i) => ({ timestamp: s(hoursAgo(h)), longPrice: flat ? 0.5 : 0.5 + i * 0.03, shortPrice: flat ? 0.49 : 0.49 - i * 0.03 })) });
    }
    if (u.pathname.endsWith("/settlement")) return json({ settlement: 1 });
    return new Response("not found", { status: 404 });
  };
}

test("price history: real bid/ask, no empty-book prices, no peeking, results, and a disk cache", async () => {
  const realFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = fakeFetch(calls) as typeof fetch;
  const cacheDir = await mkdtemp(path.join(tmpdir(), "prb-hist-"));
  try {
    const h = await loadHistory({ from: FROM, to: NOW, perPlatform: 2, platforms: ["kalshi", "polymarket_us"], cacheDir, pauseMs: 0 });
    const k = h.markets.find((m) => m.market.platform === "kalshi")!;
    assert.equal(k.market.id, KALSHI_GAME.ticker);
    assert.equal(k.result?.outcome, "yes");
    assert.equal(k.points.length, 5);
    assert.deepEqual(k.points[0], [s(hoursAgo(60)), 0.4, 0.42, 10, 500]);
    assert.equal(k.points[3][2], null, "a 1.00 ask is an empty book, not a price");
    assert.equal(k.points[4][1], null, "a 0 bid is an empty book, not a price");
    assert.equal(k.points[4][3], 50, "24h volume adds up the hourly candles");
    assert.equal(k.market.raw, undefined, "raw API objects aren't kept");

    const us = h.markets.filter((m) => m.market.platform === "polymarket_us");
    assert.equal(us.length, 1, "a market whose price never moved is skipped");
    assert.equal(us[0].result?.outcome, "yes");
    assert.equal(us[0].points[0][0], s(hoursAgo(30)) + 3600, "an hourly point is only known once its hour is over");
    assert.equal(us[0].points[0][2], 0.5);
    assert.ok(Math.abs(us[0].points[0][1]! - 0.51) < 1e-9, "YES bid = 1 − short price");

    // Finished markets come from the cache the second time.
    const before = calls.filter((c) => c.includes("candlesticks") || c.includes("price-history")).length;
    await loadHistory({ from: FROM, to: NOW, perPlatform: 2, platforms: ["kalshi", "polymarket_us"], cacheDir, pauseMs: 0 });
    const after = calls.filter((c) => c.includes("candlesticks") || c.includes("price-history")).length;
    assert.equal(after, before);
  } finally {
    globalThis.fetch = realFetch;
  }
});
