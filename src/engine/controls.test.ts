import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { applyControl, controlsPathFor, emptyControls, isStopped, loadControls, saveControls } from "./controls.js";
import { kalshiMatchCode, runPaperCycle, sameGame } from "./paper-session.js";
import { DemoAdapter } from "../platforms/demo.js";
import { createDashboardServer } from "../dashboard/server.js";
import type { PaperLedger } from "../ledger/paper.js";

const T0 = new Date("2026-11-03T20:00:00Z");

test("start / stop: one bot, all bots, and starting one while all are stopped", () => {
  let c = applyControl(emptyControls(), { action: "stop", id: "a" }, T0);
  assert.ok(isStopped(c, "a"));
  assert.ok(!isStopped(c, "b"));
  c = applyControl(c, { action: "start", id: "a" }, T0);
  assert.ok(!isStopped(c, "a"));
  assert.equal(c.resumed.a, T0.toISOString(), "Start is remembered so a loss pause can be lifted");
  c = applyControl(c, { action: "stop", all: true }, T0);
  assert.ok(isStopped(c, "a") && isStopped(c, "b"));
  const one = applyControl(c, { action: "start", id: "b" }, T0, ["a", "b", "c"]);
  assert.ok(!one.allStopped);
  assert.ok(!isStopped(one, "b"));
  assert.ok(isStopped(one, "a") && isStopped(one, "c"), "the others stay stopped");
  const all = applyControl(c, { action: "start", all: true }, T0, ["a", "b"]);
  assert.ok(!isStopped(all, "a") && !isStopped(all, "b"));
  assert.deepEqual(Object.keys(all.resumed).sort(), ["a", "b"]);
});

test("a broken controls file means everything runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-ctl-"));
  const f = path.join(dir, "c.json");
  await writeFile(f, "{oops");
  assert.deepEqual(await loadControls(f), emptyControls());
  assert.deepEqual(await loadControls(path.join(dir, "missing.json")), emptyControls());
});

test("no stacking covers every Kalshi market of one match (spread, total, team total)", () => {
  assert.equal(kalshiMatchCode("KXUCLSPREAD-26NOV03VILPSG-PSG4"), "26NOV03VILPSG");
  assert.equal(kalshiMatchCode("KXMLBGAME-26OCT232000TBMIL-TB"), "26OCT232000TBMIL");
  assert.equal(kalshiMatchCode("KXHIGHNY-26NOV03-B60"), undefined, "a date alone isn't a match");
  const held = { platform: "kalshi" as const, marketId: "KXUCLSPREAD-26NOV03VILPSG-PSG4" };
  assert.ok(sameGame(held, { platform: "kalshi", id: "KXUCLTOTAL-26NOV03VILPSG-8", eventId: "KXUCLTOTAL-26NOV03VILPSG" }));
  assert.ok(sameGame(held, { platform: "kalshi", id: "KXUCLTEAMTOTAL-26NOV03VILPSG-PSG6", eventId: "KXUCLTEAMTOTAL-26NOV03VILPSG" }));
  assert.ok(!sameGame(held, { platform: "kalshi", id: "KXUCLSPREAD-26NOV03FEYINT-INT4", eventId: "KXUCLSPREAD-26NOV03FEYINT" }), "another match");
  assert.ok(!sameGame({ platform: "kalshi", marketId: "KXHIGHNY-26NOV03-B60" }, { platform: "kalshi", id: "KXHIGHLAX-26NOV03-B70", eventId: "KXHIGHLAX-26NOV03" }));
});

const market = (id: string, bid: number, ask: number) => ({ platform: "kalshi", id, title: `${id} wins`, eventId: id.slice(0, id.lastIndexOf("-")), yesPrice: (bid + ask) / 2, yesBid: bid, yesAsk: ask, closesInHours: 30 });

async function setup() {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-ctl2-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:
  - id: buyer
    name: Buyer
    action: paper
    filters: { platforms: [kalshi], keywords_any: [wins] }
    entry: { side: yes, yes_price_above: 0.5 }
    exit: { stop_loss_pct: 0.2 }
    risk: { fire_after_n_losses: 1, pause_hours_after_losses: 24, reentry_cooldown_hours: 0 }
`,
  );
  const fixture = path.join(dir, "k.json");
  const ledgerPath = path.join(dir, "ledger.json");
  const run = async (now: Date, markets: unknown[]) => {
    await writeFile(fixture, JSON.stringify(markets));
    return runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })] });
  };
  const ledger = async () => JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const press = async (a: Parameters<typeof applyControl>[1], at = T0) => {
    const f = controlsPathFor(ledgerPath);
    await saveControls(f, applyControl(await loadControls(f), a, at, ["buyer"]));
  };
  return { dir, rules, ledgerPath, run, ledger, press };
}

test("a stopped bot makes no new trades but still sells its open ones; Start lifts a loss pause once", async () => {
  const s = await setup();
  const A = "KXNBAGAME-26NOV03BOSNYK-BOS";
  const B = "KXNBAGAME-26NOV03LALGSW-GSW";
  assert.equal((await s.run(T0, [market(A, 0.6, 0.61)])).opened, 1);
  await s.press({ action: "stop", id: "buyer" });
  // Stopped: the open trade still hits its stop loss, and the new market isn't bought.
  const r = await s.run(new Date(T0.getTime() + 600_000), [market(A, 0.4, 0.41), market(B, 0.7, 0.71)]);
  assert.equal(r.closed, 1);
  assert.equal(r.opened, 0);
  assert.ok((await s.ledger()).ruleState.buyer.pausedUntil, "that loss paused it");
  // Start: trades again, pause lifted.
  await s.press({ action: "start", id: "buyer" }, new Date(T0.getTime() + 700_000));
  const r2 = await s.run(new Date(T0.getTime() + 900_000), [market(B, 0.7, 0.71)]);
  assert.equal(r2.opened, 1);
  assert.ok(r2.events.some((e) => /started from the dashboard, loss pause lifted/.test(e.message)));
  const st = (await s.ledger()).ruleState.buyer;
  assert.equal(st.pausedUntil, undefined);
  assert.equal(st.resumedAt, new Date(T0.getTime() + 700_000).toISOString());
  // A later pause isn't lifted again by the same old Start.
  const r3 = await s.run(new Date(T0.getTime() + 1_200_000), [market(B, 0.5, 0.51)]);
  assert.equal(r3.closed, 1);
  assert.ok((await s.ledger()).ruleState.buyer.pausedUntil);
  await s.run(new Date(T0.getTime() + 1_500_000), [market(B, 0.5, 0.51)]);
  assert.ok((await s.ledger()).ruleState.buyer.pausedUntil, "still paused");
});

test("Stop all stops every bot; a bot set to never pause drops an old pause", async () => {
  const s = await setup();
  await writeFile(s.rules, (await readFile(s.rules, "utf8")).replace("fire_after_n_losses: 1", "fire_after_n_losses: 0"));
  await s.run(T0, []);
  const L = await s.ledger();
  L.ruleState.buyer = { consecutiveLosses: 0, pausedUntil: "2099-01-01T00:00:00Z" };
  await writeFile(s.ledgerPath, JSON.stringify(L));
  await s.press({ action: "stop", all: true });
  const r = await s.run(new Date(T0.getTime() + 60_000), [market("KXNBAGAME-26NOV03BOSNYK-BOS", 0.6, 0.61)]);
  assert.equal(r.opened, 0);
  assert.match(r.events[0].message, /ALL BOTS STOPPED/);
  assert.equal((await s.ledger()).ruleState.buyer.pausedUntil, undefined, "the leftover pause is gone");
  await s.press({ action: "start", all: true });
  assert.equal((await s.run(new Date(T0.getTime() + 120_000), [market("KXNBAGAME-26NOV03BOSNYK-BOS", 0.6, 0.61)])).opened, 1);
});

function post(base: string, body: string, headers: Record<string, string>): Promise<number> {
  const u = new URL(`${base}/api/control`);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the dashboard's start / stop endpoint only takes JSON from the dashboard itself", async () => {
  const s = await setup();
  await s.run(T0, []);
  const server = createDashboardServer({ ledgerPath: s.ledgerPath, rulesPath: s.rules, demo: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const host = new URL(base).host;
  const json = { "Content-Type": "application/json", Host: host };
  try {
    const stop = JSON.stringify({ action: "stop", id: "buyer" });
    assert.equal(await post(base, stop, { ...json, Origin: "https://evil.example" }), 403, "another site");
    assert.equal(await post(base, stop, { "Content-Type": "text/plain", Host: host }), 415, "a plain form post");
    assert.equal(await post(base, JSON.stringify({ action: "stop", id: "nope" }), json), 404);
    assert.equal(await post(base, JSON.stringify({ action: "explode", id: "buyer" }), json), 400);
    assert.equal(await post(base, stop, { ...json, Origin: base }), 200);
    assert.ok(isStopped(await loadControls(controlsPathFor(s.ledgerPath)), "buyer"));
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.rules.find((r: { ruleId: string }) => r.ruleId === "buyer").stopped, true);
    assert.equal((await fetch(`${base}/api/state`, { method: "POST" })).status, 405, "everything else stays read-only");
  } finally {
    server.close();
  }
});
