import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DemoAdapter } from "../platforms/demo.js";
import type { EngineEvent } from "../types.js";
import { runPaperCycle } from "./paper-session.js";
import type { PaperLedger } from "../ledger/paper.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RULES = path.join(ROOT, "rules/example.yaml");
const SNAP1 = path.join(ROOT, "fixtures/markets.json");
const SNAP2 = path.join(ROOT, "fixtures/markets.later.json");
const T0 = new Date("2026-10-26T19:00:00Z");
const T1 = new Date("2026-10-27T01:00:00Z");

function adapters(fixturePath: string, now: Date) {
  return (["kalshi", "polymarket"] as const).map((id) => new DemoAdapter(id, { fixturePath, now: () => now }));
}

async function cycle(ledgerPath: string, fixture: string, now: Date) {
  const events: EngineEvent[] = [];
  const res = await runPaperCycle({
    rulesPath: RULES,
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

test("demo paper flow: entries, no duplicates, exits, PnL and loss pause", async () => {
  const ledgerPath = path.join(await mkdtemp(path.join(tmpdir(), "prb-")), "ledger.json");

  const r1 = await cycle(ledgerPath, SNAP1, T0);
  assert.equal(r1.opened, 4);
  assert.equal(r1.closed, 0);
  // Alert rules never write to the ledger.
  assert.ok(r1.events.some((e) => e.type === "entry_signal" && e.data?.action === "alert"));

  const r2 = await cycle(ledgerPath, SNAP1, new Date(T0.getTime() + 60_000));
  assert.equal(r2.opened, 0, "re-running the same snapshot must not double-buy");

  const r3 = await cycle(ledgerPath, SNAP2, T1);
  assert.equal(r3.closed, 4);
  assert.equal(r3.opened, 1); // dip-reversion entry on the 8¢ drop
  assert.equal(r3.realizedPnlUsd, -29.19);

  const reasons = r3.events.filter((e) => e.type === "paper_exit").map((e) => e.data?.reason).sort();
  assert.deepEqual(reasons, ["resolved", "stop_loss", "stop_loss", "take_profit"]);
  assert.ok(
    r3.events.some((e) => e.type === "risk_block" && e.ruleId === "favorite-carry-no-paper" && /paused until/.test(e.message)),
    "2 straight losses should pause favorite-carry-no-paper and block the next match",
  );

  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.equal(ledger.version, 2);
  assert.equal(ledger.demo, true);
  assert.ok(ledger.ruleState["favorite-carry-no-paper"].pausedUntil);
  assert.equal(ledger.positions.filter((p) => p.status === "open").length, 1);
  assert.equal(ledger.fills.filter((f) => f.kind === "close").length, 4);
  const dip = ledger.positions.find((p) => p.ruleId === "dip-reversion-paper")!;
  assert.ok((dip.unrealizedPnlUsd ?? 0) < 0, "fresh fills are marked at the bid, so the spread shows as a cost");

  // Re-entry cooldown: same snapshot again → nothing new, nothing closed.
  const r4 = await cycle(ledgerPath, SNAP2, new Date(T1.getTime() + 60_000));
  assert.equal(r4.opened, 0);
  assert.equal(r4.closed, 0);
});
