import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "../dashboard/server.js";
import { LabQuery, luckChance, runLab, toParams } from "./api.js";
import { saveLab, type LabData, type LabMarket } from "./data.js";

const START = Date.parse("2026-10-01T00:00:00Z");
const DAY = 86_400_000;
/** 120 games: the favorite costs about 80¢ and wins 5 times in 6. */
function sample(): LabData {
  const markets: LabMarket[] = [];
  for (let i = 0; i < 120; i++) {
    const favWon = i % 6 !== 0;
    const e = `KXNBAGAME-G${i}`;
    const st = START + i * (DAY / 4);
    markets.push({ t: `${e}-FAV`, e, s: i % 2 ? "KXNBAGAME" : "KXNHLGAME", n: `Fav ${i}`, q: `Game ${i}`, r: favWon ? 1 : 0, st, p: [12, 770, 790, 1, 790, 810] });
    markets.push({ t: `${e}-DOG`, e, s: i % 2 ? "KXNBAGAME" : "KXNHLGAME", n: `Dog ${i}`, q: `Game ${i}`, r: favWon ? 0 : 1, st, p: [12, 210, 230, 1, 190, 210] });
  }
  return { version: 1, fetchedAt: "2026-11-09T00:00:00Z", markets };
}

test("settings arrive in cents and percents and are read into the engine's units", () => {
  const p = toParams(LabQuery.parse({ pick: "riser", min: "95", max: "30", move: "2.5", pct: "3", leagues: "KXNBAGAME, bad one!,KXNFLGAME", start: "2026-10-01", end: "2026-10-31" }));
  assert.deepEqual([p.minPrice, p.maxPrice, p.minMove, p.pct], [0.3, 0.95, 0.025, 0.03]);
  assert.deepEqual(p.leagues, ["KXNBAGAME", "KXNFLGAME"]);
  assert.equal(p.to! - p.from!, 31 * DAY - 1000);
  assert.equal(LabQuery.safeParse({ runs: "999999" }).success, false);
  assert.equal(LabQuery.safeParse({ pick: "magic" }).success, false);
  // t = 0 is a coin flip; t = 2 is about 2.3%.
  assert.equal(+luckChance(0).toFixed(2), 0.5);
  assert.equal(+luckChance(2).toFixed(3), 0.023);
  assert.equal(+luckChance(-2).toFixed(3), 0.023);
});

test("a run: stats, thinned equity, breakdowns, latest trades, a simulation and notes", () => {
  const out = runLab(sample(), LabQuery.parse({ pick: "favorite", min: 50, max: 95, runs: 500, size: 50 }));
  assert.deepEqual([out.stats.bets, out.stats.wins], [120, 100]);
  assert.equal(+out.stats.avgPrice.toFixed(2), 0.81);
  assert.equal(out.equity.length, 120);
  assert.equal(out.equity.at(-1)![1], Math.round(out.stats.pnl * 100) / 100);
  assert.deepEqual(out.byLeague.map((s) => s.label).sort(), ["NBA", "NHL"]);
  assert.equal(out.trades.length, 120);
  assert.ok(out.trades[0].at > out.trades[1].at, "newest first");
  assert.deepEqual([out.mc!.runs, out.mc!.horizon], [500, 120]);
  assert.match(out.yaml!, /id: lab-favorite-50-95/);
  assert.deepEqual(out.notes, []);
  // The optimistic and odd settings each carry a plain warning.
  const maker = runLab(sample(), LabQuery.parse({ exec: "maker", min: 50, max: 95, exit: "pregame", exitH: 6, entry: 1 }));
  assert.equal(maker.notes.length, 2);
  assert.match(maker.notes[0], /assumed to fill every time/);
  assert.equal(maker.yaml, null);
  // Sell an hour before the start works here; "at the start" has no price in this data, and the run says how many bets that changed.
  const sold = runLab(sample(), LabQuery.parse({ min: 50, max: 95, entry: 12, exit: "pregame", exitH: 1 }));
  assert.deepEqual(sold.notes, []);
  assert.ok(sold.trades.every((t) => t.exit === 0.79));
  const unsold = runLab(sample(), LabQuery.parse({ min: 50, max: 95, entry: 12, exit: "pregame", exitH: 0 }));
  assert.match(unsold.notes[0], /^120 of 120 bets had no usable price at the sell time/);
  // A test on hand-picked leagues says how the same test did on all of them.
  const picked = runLab(sample(), LabQuery.parse({ min: 50, max: 95, leagues: "KXNBAGAME" }));
  assert.equal(picked.stats.bets, 60);
  assert.match(picked.notes[0], /^On every league, the same test made 120 bets for [+−]\d+\.\d% per \$1 \(here: [+−]\d+\.\d%\)\. Leagues chosen because they did best/);
  assert.deepEqual(runLab(sample(), LabQuery.parse({ min: 50, max: 95, leagues: "KXNBAGAME,KXNHLGAME" })).notes, [], "every league picked is no pick at all");
  // Whether the bot can paper trade the test, and as what.
  assert.deepEqual(picked.paper, { ok: true, id: picked.paper.ok ? picked.paper.id : "", name: "Lab favorites 50–95¢, NBA", notes: ["Paper fills add half a cent of slippage to every buy, which the test doesn't."] });
  const cant = runLab(sample(), LabQuery.parse({ pick: "underdog", min: 10, max: 30 })).paper;
  assert.deepEqual([cant.ok, cant.ok ? "" : /can't tell which side is the underdog/.test(cant.why)], [false, true]);
  // Bets too big for the bankroll: the test still measures every bet, and says when the money would have run out.
  const big = runLab(sample(), LabQuery.parse({ pick: "underdog", min: 10, max: 30, size: 400, bank: 1000 }));
  assert.equal(big.stats.bets, 120);
  assert.match(big.notes[0], /would have run out on Oct \d+/);
  // Nothing matches: no simulation, and it says so.
  const none = runLab(sample(), LabQuery.parse({ min: 1, max: 2 }));
  assert.deepEqual([none.stats.bets, none.mc, none.verdict], [0, null, "no bets matched"]);
});

function request(base: string, method: string, pathname: string, headers: Record<string, string> = {}, body = "{}"): Promise<{ status: number; json: Record<string, never> }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Host: u.host, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text.startsWith("{") ? JSON.parse(text) : {} }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? body : undefined);
  });
}

test("the dashboard serves the lab: status, runs, and a guarded background download", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-lab-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(rules, "rules:\n  - id: a\n    name: A\n    entry: { yes_price_above: 0.5 }\n");
  const ledgerPath = path.join(dir, "ledger.json");
  let downloads = 0;
  const server = createDashboardServer({
    ledgerPath,
    rulesPath: rules,
    demo: true,
    labDownload: async (o) => {
      downloads++;
      o?.onProgress?.({ stage: "prices", done: 1, total: 2 });
      return sample();
    },
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { "Content-Type": "application/json" };
  try {
    // Nothing downloaded yet.
    let status = (await request(base, "GET", "/api/lab/status")).json as unknown as { dataset: { games: number }; update: { running: boolean; added?: number; error?: string } };
    assert.equal(status.dataset.games, 0);
    assert.equal((await request(base, "GET", "/api/lab/run")).status, 400);
    // Only this page can start a download.
    assert.equal((await request(base, "POST", "/api/lab/update", { ...json, Origin: "https://evil.example" })).status, 403);
    assert.equal((await request(base, "POST", "/api/lab/update", { "Content-Type": "text/plain" })).status, 415);
    assert.equal(downloads, 0);
    assert.equal((await request(base, "POST", "/api/lab/update", { ...json, Origin: base })).status, 202);
    for (let i = 0; i < 50; i++) {
      status = (await request(base, "GET", "/api/lab/status")).json as never;
      if (!status.update.running && status.dataset.games) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    assert.deepEqual([status.dataset.games, status.update.added, status.update.error, downloads], [120, 120, undefined, 1]);
    assert.equal((JSON.parse(await readFile(path.join(dir, "lab-games.json"), "utf8")) as LabData).markets.length, 240);
    // A run with settings in the address.
    const run = await request(base, "GET", "/api/lab/run?pick=underdog&min=10&max=30&runs=200&bank=500&size=10");
    assert.equal(run.status, 200);
    const r = run.json as unknown as { stats: { bets: number; wins: number }; mc: { runs: number } };
    assert.deepEqual([r.stats.bets, r.stats.wins, r.mc.runs], [120, 20, 200]);
    assert.equal((await request(base, "GET", "/api/lab/run?pick=nonsense")).status, 400);
    // The paper ledger was never created by any of this.
    await assert.rejects(readFile(ledgerPath, "utf8"));
  } finally {
    server.close();
  }
});

test("a dataset saved by hand is picked up without a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-lab2-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(rules, "rules:\n  - id: a\n    name: A\n    entry: { yes_price_above: 0.5 }\n");
  const server = createDashboardServer({ ledgerPath: path.join(dir, "ledger.json"), rulesPath: rules, demo: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal(((await request(base, "GET", "/api/lab/status")).json as unknown as { dataset: { games: number } }).dataset.games, 0);
    await saveLab(path.join(dir, "lab-games.json"), sample());
    assert.equal(((await request(base, "GET", "/api/lab/status")).json as unknown as { dataset: { games: number } }).dataset.games, 120);
  } finally {
    server.close();
  }
});
