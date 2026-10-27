import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleSchema, type Rule } from "../rules/schema.js";
import type { EngineEvent, NormalizedMarket } from "../types.js";
import { evaluateRules } from "./runner.js";
import type { PriorPrice } from "./evaluate.js";
import { checkEntryRisk, defaultRiskState, type RiskState } from "./risk.js";

const NOW = new Date("2026-10-26T19:00:00Z");

function rule(over: Record<string, unknown>): Rule {
  return RuleSchema.parse({ id: "r", name: "r", ...over });
}

const m = (yes: number): NormalizedMarket => ({ platform: "polymarket", id: "p1", title: "Test", yesPrice: yes });

async function run(rules: Rule[], markets: NormalizedMarket[], extra: Partial<Parameters<typeof evaluateRules>[0]> = {}) {
  const events: EngineEvent[] = [];
  const res = await evaluateRules({
    rules,
    markets,
    mode: "alert",
    now: NOW,
    push: async (e) => {
      events.push(e);
    },
    history: new Map<string, PriorPrice>(),
    riskByRule: new Map<string, RiskState>(),
    ...extra,
  });
  return { events, ...res };
}

test("every rule compares against the previous scan, not a price another rule just wrote", async () => {
  const history = new Map<string, PriorPrice>([["polymarket:p1", { yesPrice: 0.5, at: NOW.toISOString() }]]);
  const a = rule({ id: "a", entry: { yes_price_move_abs: 0.05 } });
  const b = rule({ id: "b", entry: { yes_price_move_abs: 0.05 } });
  const { signals } = await run([a, b], [m(0.4)], { history });
  assert.equal(signals, 2);
  assert.equal(history.get("polymarket:p1")?.yesPrice, 0.4);
});

test("move_direction filters up vs down moves", async () => {
  const prior = () => new Map<string, PriorPrice>([["polymarket:p1", { yesPrice: 0.5, at: NOW.toISOString() }]]);
  const down = rule({ entry: { yes_price_move_abs: 0.05, move_direction: "down" } });
  assert.equal((await run([down], [m(0.4)], { history: prior() })).signals, 1);
  assert.equal((await run([down], [m(0.6)], { history: prior() })).signals, 0);
});

test("watch edge-trigger suppresses repeats until the match clears", async () => {
  const r = rule({ filters: { min_price: 0.3 } });
  const lastMatched = new Set<string>();
  assert.equal((await run([r], [m(0.4)], { lastMatched })).signals, 1);
  const again = await run([r], [m(0.4)], { lastMatched });
  assert.equal(again.signals, 0);
  assert.equal(again.suppressed, 1);
  await run([r], [m(0.2)], { lastMatched }); // stops matching
  assert.equal((await run([r], [m(0.4)], { lastMatched })).signals, 1);
});

test("alert-only runs never consume open-position capacity", async () => {
  const r = rule({ action: "paper", risk: { max_open_positions: 1 } });
  const riskByRule = new Map<string, RiskState>();
  for (let i = 0; i < 3; i++) {
    const { signals } = await run([r], [m(0.5)], { riskByRule });
    assert.equal(signals, 1);
  }
  assert.equal(riskByRule.get("r")?.openPositions, 0);
});

test("paper mode only fills action: paper rules unless paperAll", async () => {
  const alertRule = rule({ id: "alert-only", action: "alert" });
  const riskByRule = new Map<string, RiskState>();
  const { events } = await run([alertRule], [m(0.5)], { mode: "paper", riskByRule });
  assert.equal(events.find((e) => e.type === "entry_signal")?.data?.action, "alert");
  assert.equal(riskByRule.get("alert-only")?.openPositions, 0);

  const all = await run([alertRule], [m(0.5)], { mode: "paper", paperAll: true, riskByRule });
  assert.equal(all.events.find((e) => e.type === "entry_signal")?.data?.action, "paper");
  assert.equal(riskByRule.get("alert-only")?.openPositions, 1);
});

test("bankroll gate blocks entries that exceed equity", () => {
  const r = rule({ risk: { bankroll_usd: 100, position_size_fraction: 0.5, max_open_positions: 10 } });
  const state: RiskState = { ...defaultRiskState("2026-10-26"), openExposureUsd: 60, realizedPnlUsd: 0 };
  assert.match(checkEntryRisk(r, state, NOW).reason ?? "", /insufficient bankroll/);
  assert.equal(checkEntryRisk(r, { ...state, realizedPnlUsd: 20 }, NOW).ok, true);
  assert.equal(checkEntryRisk(r, defaultRiskState("2026-10-26"), NOW).ok, true); // alert mode: no exposure tracking
});

test("duplicate rule ids are rejected (they key the ledger)", async () => {
  const { RulesFileSchema } = await import("../rules/schema.js");
  const res = RulesFileSchema.safeParse({ rules: [{ id: "x", name: "a" }, { id: "x", name: "b" }] });
  assert.equal(res.success, false);
});
