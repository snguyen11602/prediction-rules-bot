import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  closePosition,
  emptyLedger,
  loadLedger,
  markPosition,
  openPosition,
  riskStateFromLedger,
  saveLedger,
  summarizeLedger,
  withLedgerLock,
} from "./paper.js";

const NOW = new Date("2026-10-26T19:00:00Z");

async function tmp(name: string): Promise<string> {
  return path.join(await mkdtemp(path.join(tmpdir(), "prb-")), name);
}

function base(over: Partial<Parameters<typeof openPosition>[1]> = {}) {
  return {
    ruleId: "r1",
    platform: "kalshi" as const,
    marketId: "M1",
    title: "m",
    side: "yes" as const,
    price: 0.5,
    sizeUsd: 100,
    at: NOW,
    ...over,
  };
}

test("open → mark → close computes contracts, unrealized and realized PnL with fees", () => {
  const l = emptyLedger(false, NOW);
  const p = openPosition(l, base({ feeUsd: 1 }));
  assert.equal(p.contracts, 200);
  markPosition(p, 0.6, NOW);
  assert.equal(p.unrealizedPnlUsd, 19); // 200×0.6 − 100 − 1
  const pnl = closePosition(l, p, { price: 0.6, at: NOW, reason: "take_profit", feeUsd: 0.5 });
  assert.equal(pnl, 18.5);
  assert.equal(p.status, "closed");
  assert.deepEqual(
    l.fills.map((f) => f.kind),
    ["open", "close"],
  );
  assert.equal(l.fills[1].pnlUsd, 18.5);
  assert.throws(() => closePosition(l, p, { price: 1, at: NOW, reason: "resolved" }));
});

test("resolution settles the NO side at 0 or 1", () => {
  const l = emptyLedger(false, NOW);
  const win = openPosition(l, base({ side: "no", price: 0.8, sizeUsd: 80 }));
  const lose = openPosition(l, base({ side: "no", price: 0.8, sizeUsd: 80, marketId: "M2" }));
  assert.equal(closePosition(l, win, { price: 1, at: NOW, reason: "resolved" }), 20);
  assert.equal(closePosition(l, lose, { price: 0, at: NOW, reason: "resolved" }), -80);
  const s = summarizeLedger(l).total;
  assert.equal(s.wins, 1);
  assert.equal(s.losses, 1);
  assert.equal(s.realizedPnlUsd, -60);
});

test("rejects impossible entry prices", () => {
  const l = emptyLedger(false, NOW);
  assert.throws(() => openPosition(l, base({ price: 1 })));
  assert.throws(() => openPosition(l, base({ price: 0 })));
});

test("risk state is rebuilt from the ledger", () => {
  const l = emptyLedger(false, NOW);
  openPosition(l, base());
  const closed = openPosition(l, base({ marketId: "M2" }));
  closePosition(l, closed, { price: 0.25, at: NOW, reason: "stop_loss" });
  l.ruleState.r1 = { consecutiveLosses: 1, pausedUntil: "2099-01-01T00:00:00.000Z" };
  const rs = riskStateFromLedger(l, "r1", NOW);
  assert.equal(rs.openPositions, 1);
  assert.equal(rs.openExposureUsd, 100);
  assert.equal(rs.realizedPnlUsd, -50);
  assert.equal(rs.dayPnlUsd, -50);
  assert.equal(rs.consecutiveLosses, 1);
  assert.equal(rs.pausedUntil, "2099-01-01T00:00:00.000Z");
  assert.equal(riskStateFromLedger(l, "other", NOW).openPositions, 0);
});

test("v1 ledgers migrate their fills to open positions", async () => {
  const file = await tmp("v1.json");
  await writeFile(
    file,
    JSON.stringify({
      version: 1,
      fills: [
        {
          id: "f1",
          at: NOW.toISOString(),
          ruleId: "r1",
          platform: "polymarket",
          marketId: "p1",
          title: "x",
          side: "yes",
          price: 0.25,
          sizeUsd: 50,
          hypothetical: true,
        },
      ],
    }),
  );
  const l = await loadLedger(file, { demo: false });
  assert.equal(l.version, 2);
  assert.equal(l.positions.length, 1);
  assert.equal(l.positions[0].contracts, 200);
  assert.equal(l.positions[0].status, "open");
});

test("missing ledger starts empty; corrupt ledger throws instead of being overwritten", async () => {
  const missing = await tmp("none.json");
  assert.equal((await loadLedger(missing, { demo: false })).positions.length, 0);
  const bad = await tmp("bad.json");
  await writeFile(bad, "{ not json");
  await assert.rejects(loadLedger(bad, { demo: false }), /not valid JSON/);
  assert.equal(await readFile(bad, "utf8"), "{ not json");
});

test("demo and real-data ledgers never mix", async () => {
  const file = await tmp("demo.json");
  await saveLedger(file, emptyLedger(true, NOW));
  await assert.rejects(loadLedger(file, { demo: false }), /refusing to mix/);
  assert.equal((await loadLedger(file, { demo: true })).demo, true);
});

test("ledger lock blocks a concurrent run and is released afterwards", async () => {
  const file = await tmp("locked.json");
  await withLedgerLock(file, async () => {
    await assert.rejects(withLedgerLock(file, async () => 1), /locked/);
  });
  assert.equal(await withLedgerLock(file, async () => 42), 42);
});
