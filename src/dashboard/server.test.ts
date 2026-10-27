import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import http from "node:http";
import { DemoAdapter } from "../platforms/demo.js";
import { runPaperCycle } from "../engine/paper-session.js";
import { createDashboardServer } from "./server.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const RULES = path.join(ROOT, "rules/example.yaml");

async function ledgerWithTrades(): Promise<string> {
  const ledgerPath = path.join(await mkdtemp(path.join(tmpdir(), "prb-dash-")), "ledger.json");
  const t0 = new Date("2026-10-26T19:00:00Z");
  const t1 = new Date("2026-10-26T19:30:00Z");
  for (const [fixture, now] of [["fixtures/markets.json", t0], ["fixtures/markets.later.json", t1]] as const) {
    await runPaperCycle({
      rulesPath: RULES,
      ledgerPath,
      demo: true,
      now,
      emit: () => undefined,
      adapters: (["kalshi", "polymarket"] as const).map(
        (id) => new DemoAdapter(id, { fixturePath: path.join(ROOT, fixture), now: () => now }),
      ),
    });
  }
  return ledgerPath;
}

async function serve(ledgerPath: string) {
  const server = createDashboardServer({ ledgerPath, rulesPath: RULES, demo: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, base };
}

test("dashboard serves the page and a ledger snapshot", async () => {
  const { server, base } = await serve(await ledgerWithTrades());
  try {
    const page = await fetch(`${base}/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-security-policy") ?? "", /default-src 'none'/);
    assert.match(await page.text(), /<title>Paper Trading<\/title>/);

    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.ok, true);
    assert.equal(state.ledger.demo, true);
    assert.equal(state.open.length, 1);
    assert.equal(state.closed.length, 4);
    assert.equal(state.pnlSeries.length, 4);
    assert.equal(state.pnlSeries.at(-1).cumPnlUsd, -29.06);
    assert.equal(state.totals.realizedPnlUsd, -29.06);
    assert.equal(state.ruleNames["macro-econ-alert"], "Fed / CPI / jobs markets resolving within two weeks");
    assert.ok(state.rules.some((r: { ruleId: string; pausedUntil?: string }) => r.ruleId === "favorite-carry-no-paper" && r.pausedUntil));
  } finally {
    server.close();
  }
});

test("dashboard is read-only and only answers localhost", async () => {
  const { server, base } = await serve(await ledgerWithTrades());
  try {
    assert.equal((await fetch(`${base}/api/state`, { method: "POST" })).status, 405);
    // fetch() won't override Host, so send a raw request like a DNS-rebinding page would.
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      http
        .get({ host: "127.0.0.1", port, path: "/api/state", headers: { Host: "evil.example" } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on("error", reject);
    });
    assert.equal(status, 403);
    assert.equal((await fetch(`${base}/nope`)).status, 404);
  } finally {
    server.close();
  }
});

test("a broken ledger is reported, not crashed on", async () => {
  const bad = path.join(await mkdtemp(path.join(tmpdir(), "prb-dash-")), "ledger.json");
  await writeFile(bad, "{ nope");
  const { server, base } = await serve(bad);
  try {
    const res = await fetch(`${base}/api/state`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error, /not valid JSON/);
  } finally {
    server.close();
  }
});
