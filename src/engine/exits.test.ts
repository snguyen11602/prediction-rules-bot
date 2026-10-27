import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateExit } from "./exits.js";
import { buyPrice, canTrade, sellPrice, settlementPrice } from "./pricing.js";
import type { NormalizedMarket } from "../types.js";

const NOW = new Date("2026-10-26T12:00:00Z");

function mkt(over: Partial<NormalizedMarket> = {}): NormalizedMarket {
  return {
    platform: "kalshi",
    id: "T",
    title: "t",
    yesPrice: 0.5,
    closesAt: new Date(NOW.getTime() + 100 * 3600_000).toISOString(),
    ...over,
  };
}

const pos = { entryAt: NOW.toISOString(), entryPrice: 0.5 };

test("no exit config → never exits", () => {
  assert.equal(evaluateExit(undefined, pos, mkt(), 0.01, NOW), null);
});

test("stop_loss_price fires at the boundary, not above it", () => {
  assert.equal(evaluateExit({ stop_loss_price: 0.4 }, pos, mkt(), 0.41, NOW), null);
  assert.equal(evaluateExit({ stop_loss_price: 0.4 }, pos, mkt(), 0.4, NOW)?.reason, "stop_loss");
});

test("take_profit_pct / stop_loss_pct are relative to entry", () => {
  assert.equal(evaluateExit({ take_profit_pct: 0.2 }, pos, mkt(), 0.59, NOW), null);
  assert.equal(evaluateExit({ take_profit_pct: 0.2 }, pos, mkt(), 0.6, NOW)?.reason, "take_profit");
  assert.equal(evaluateExit({ stop_loss_pct: 0.3 }, pos, mkt(), 0.35, NOW)?.reason, "stop_loss");
});

test("stop loss wins over take profit if both are hit", () => {
  const d = evaluateExit({ stop_loss_price: 0.6, take_profit_price: 0.5 }, pos, mkt(), 0.55, NOW);
  assert.equal(d?.reason, "stop_loss");
});

test("time-based exits", () => {
  const soon = mkt({ closesAt: new Date(NOW.getTime() + 5 * 3600_000).toISOString() });
  assert.equal(evaluateExit({ max_hours_to_resolve: 6 }, pos, soon, 0.5, NOW)?.reason, "time_to_resolve");
  const old = { entryAt: new Date(NOW.getTime() - 49 * 3600_000).toISOString(), entryPrice: 0.5 };
  assert.equal(evaluateExit({ max_hold_hours: 48 }, old, mkt(), 0.5, NOW)?.reason, "max_hold");
  assert.equal(evaluateExit({ max_hold_hours: 48 }, pos, mkt(), 0.5, NOW), null);
});

test("pricing uses bid/ask for the held side, with slippage against you", () => {
  const m = mkt({ yesPrice: 0.4, yesBid: 0.39, yesAsk: 0.41 });
  assert.equal(buyPrice(m, "yes"), 0.41);
  assert.equal(sellPrice(m, "yes"), 0.39);
  assert.ok(Math.abs(buyPrice(m, "no") - 0.61) < 1e-9); // 1 − YES bid
  assert.ok(Math.abs(sellPrice(m, "no") - 0.59) < 1e-9); // 1 − YES ask
  assert.ok(Math.abs(buyPrice(m, "yes", 0.01) - 0.42) < 1e-9);
  assert.ok(Math.abs(sellPrice(m, "yes", 0.01) - 0.38) < 1e-9);
});

test("pricing falls back to mid without quotes; settlement is 1/0", () => {
  const m = mkt({ yesPrice: 0.3 });
  assert.equal(buyPrice(m, "yes"), 0.3);
  assert.ok(Math.abs(sellPrice(m, "no") - 0.7) < 1e-9);
  assert.equal(settlementPrice(m, "yes"), undefined);
  const r = mkt({ status: "resolved", resolvedOutcome: "no" });
  assert.equal(settlementPrice(r, "no"), 1);
  assert.equal(settlementPrice(r, "yes"), 0);
});

test("canTrade needs the right side of the book; split payouts settle fractionally", () => {
  const onlyAsk = mkt({ yesAsk: 0.5 });
  assert.equal(canTrade(onlyAsk, "yes", "buy"), true);
  assert.equal(canTrade(onlyAsk, "yes", "sell"), false); // no YES bid
  assert.equal(canTrade(onlyAsk, "no", "sell"), true); // NO bid = 1 − YES ask
  assert.equal(canTrade(onlyAsk, "no", "buy"), false); // NO ask needs a YES bid
  assert.equal(canTrade(mkt(), "yes", "sell"), true); // adapter has no quotes → mid fallback
  const split = mkt({ status: "resolved", settlementYesPrice: 0.5 });
  assert.equal(settlementPrice(split, "yes"), 0.5);
  assert.equal(settlementPrice(split, "no"), 0.5);
  assert.equal(settlementPrice(mkt({ status: "resolved" }), "yes"), undefined);
});
