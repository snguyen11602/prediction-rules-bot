import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DemoAdapter } from "../platforms/demo.js";
import type { EngineEvent } from "../types.js";
import { runPaperCycle } from "./paper-session.js";
import type { PaperLedger } from "../ledger/paper.js";
import { rulesWithAllArbPaths } from "./test-utils.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RULES = path.join(ROOT, "rules/example.yaml");
const SNAP1 = path.join(ROOT, "fixtures/markets.json");
const SNAP2 = path.join(ROOT, "fixtures/markets.later.json");
const T0 = new Date("2026-10-26T19:00:00Z");
const T1 = new Date("2026-10-26T19:30:00Z"); // 30 min later: within dip-reversion's 60-minute window

function adapters(fixturePath: string, now: Date) {
  return (["kalshi", "polymarket"] as const).map((id) => new DemoAdapter(id, { fixturePath, now: () => now }));
}

let rulesPath = RULES;
async function cycle(ledgerPath: string, fixture: string, now: Date) {
  const events: EngineEvent[] = [];
  const res = await runPaperCycle({
    rulesPath,
    ledgerPath,
    demo: true,
    now,
    adapters: adapters(fixture, now),
    emit: (e) => {
      events.push(e);
    },
  });
  return { ...res, events };
}

test("default arbitrage settings: auto-matched pairs alert but don't trade", async () => {
  rulesPath = RULES;
  const ledgerPath = path.join(await mkdtemp(path.join(tmpdir(), "prb-")), "ledger.json");
  const r = await cycle(ledgerPath, SNAP1, T0);
  assert.equal(r.arb?.opened, 1, "only the mayor NO basket (platform-flagged) trades by default");
  const fed = r.events.find((e) => e.type === "arb_signal" && /Fed decision/.test(e.message));
  assert.ok(fed && /arb:confirm/.test(fed.message), "the auto-matched Fed pair is reported with how to confirm it");
  assert.ok(!r.events.some((e) => e.type === "arb_signal" && /YES on all/.test(e.message)), "YES baskets are off by default");
});

test("demo paper flow: entries, no duplicates, exits, PnL and loss pause", async () => {
  rulesPath = await rulesWithAllArbPaths();
  const ledgerPath = path.join(await mkdtemp(path.join(tmpdir(), "prb-")), "ledger.json");

  const r1 = await cycle(ledgerPath, SNAP1, T0);
  assert.equal(r1.opened, 4);
  assert.equal(r1.closed, 0);
  assert.equal(r1.arb?.opened, 3, "film YES basket, Fed cross pair, mayor NO basket");
  // Alert rules never write to the ledger.
  assert.ok(r1.events.some((e) => e.type === "entry_signal" && e.data?.action === "alert"));

  const r2 = await cycle(ledgerPath, SNAP1, new Date(T0.getTime() + 60_000));
  assert.equal(r2.opened, 0, "re-running the same snapshot must not double-buy");
  assert.equal(r2.arb?.opened, 0, "arbs already held are not bought again");

  const r3 = await cycle(ledgerPath, SNAP2, T1);
  assert.equal(r3.closed, 4);
  assert.equal(r3.opened, 1); // dip-reversion entry on the 8¢ drop
  assert.equal(r3.realizedPnlUsd, -29.06); // Kalshi fills are whole contracts

  assert.equal(r3.arb?.closed, 2, "Fed pair sold early, mayor basket resolved");
  assert.equal(r3.arb?.realizedPnlUsd, 7.66);

  const reasons = r3.events
    .filter((e) => e.type === "paper_exit" && e.ruleId !== "arbitrage")
    .map((e) => e.data?.reason)
    .sort();
  assert.deepEqual(reasons, ["resolved", "stop_loss", "stop_loss", "take_profit"]);
  assert.ok(
    r3.events.some((e) => e.type === "risk_block" && e.ruleId === "favorite-carry-no-paper" && /paused until/.test(e.message)),
    "2 straight losses should pause favorite-carry-no-paper and block the next match",
  );

  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.equal(ledger.version, 2);
  assert.equal(ledger.demo, true);
  assert.ok(ledger.ruleState["favorite-carry-no-paper"].pausedUntil);
  const solo = ledger.positions.filter((p) => !p.groupId);
  assert.equal(solo.filter((p) => p.status === "open").length, 1);
  assert.equal(ledger.fills.filter((f) => f.kind === "close" && f.ruleId !== "arbitrage").length, 4);
  // A winning arb whose single leg lost must not count toward the loss streak.
  assert.equal(ledger.ruleState.arbitrage?.consecutiveLosses ?? 0, 0);
  const dip = ledger.positions.find((p) => p.ruleId === "dip-reversion-paper")!;
  assert.ok((dip.unrealizedPnlUsd ?? 0) < 0, "fresh fills are marked at the bid, so the spread shows as a cost");

  // Re-entry cooldown: same snapshot again → nothing new, nothing closed.
  const r4 = await cycle(ledgerPath, SNAP2, new Date(T1.getTime() + 60_000));
  assert.equal(r4.opened, 0);
  assert.equal(r4.closed, 0);
  assert.equal(r4.arb?.opened, 0);
});

test("an empty bid on the held side holds the position instead of selling at 0", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-"));
  const ledgerPath = path.join(dir, "ledger.json");
  await cycle(ledgerPath, SNAP1, T0);

  const rows = JSON.parse(await readFile(SNAP1, "utf8")) as Array<Record<string, unknown>>;
  const rain = rows.find((r) => r.id === "DEMO-RAIN-NYC")!;
  delete rain.yesBid; // bid side of the book is empty; only an ask remains
  rain.yesAsk = 0.5;
  rain.yesPrice = 0.5;
  const emptyBid = path.join(dir, "empty-bid.json");
  await writeFile(emptyBid, JSON.stringify(rows));

  const r = await cycle(ledgerPath, emptyBid, T1);
  assert.equal(
    r.events.filter((e) => e.type === "paper_exit" && e.market?.id === "DEMO-RAIN-NYC").length,
    0,
    "must not stop out against an empty book",
  );
  assert.ok(r.events.some((e) => e.type === "info" && /no bid for YES; holding/.test(e.message)));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const pos = ledger.positions.find((p) => p.marketId === "DEMO-RAIN-NYC")!;
  assert.equal(pos.status, "open");
  assert.equal(pos.lastMarkPrice, 0.5);
});

test("a split resolution settles at the actual payout", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-"));
  const ledgerPath = path.join(dir, "ledger.json");
  await cycle(ledgerPath, SNAP1, T0);
  const rows = JSON.parse(await readFile(SNAP1, "utf8")) as Array<Record<string, unknown>>;
  Object.assign(rows.find((r) => r.id === "demo-poly-4")!, {
    status: "resolved",
    settlementYesPrice: 0.5,
    yesPrice: 0.5,
    yesBid: undefined,
    yesAsk: undefined,
  });
  const split = path.join(dir, "split.json");
  await writeFile(split, JSON.stringify(rows));
  const r = await cycle(ledgerPath, split, T1);
  const exit = r.events.find((e) => e.type === "paper_exit" && e.market?.id === "demo-poly-4");
  assert.equal(exit?.data?.reason, "resolved");
  assert.match(exit?.message ?? "", /0\.935 → 0\.500/);
});
