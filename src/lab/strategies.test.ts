import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { createDashboardServer } from "../dashboard/server.js";
import { runPaperCycle } from "../engine/paper-session.js";
import { DemoAdapter } from "../platforms/demo.js";
import type { PaperLedger } from "../ledger/paper.js";
import { LabQuery } from "./api.js";
import {
  activeStrategies, addStrategy, emptyStrategies, labRules, LabStrategyError, loadStrategies, MAX_LAB_STRATEGIES, parseSettings, removeStrategy, restoreStrategy, saveStrategies,
  strategiesPathFor, type LabStrategyFile,
} from "./strategies.js";

const NOW = new Date("2026-11-10T20:00:00Z");
/** The strategy from the lab: NBA + La Liga favorites at 75–100¢, three hours before the start, $500 a bet from $5,000. */
const MINE = { pick: "favorite", min: 75, max: 100, entry: 3, leagues: "KXNBAGAME,KXLALIGAGAME", bank: 5000, stake: "flat", size: 500 };
const q = (over: Record<string, unknown> = {}) => LabQuery.parse({ ...MINE, ...over });

test("the store: add, change the bet size, remove, undo, and the limits", () => {
  const data = emptyStrategies();
  const first = addStrategy(data, q(), { now: NOW, test: { at: NOW.toISOString(), bets: 61, pnl: 120, ret: 0.02, retSe: 0.03, verdict: "ahead, but within luck" } });
  assert.equal(first.outcome, "added");
  assert.match(first.strategy.id, /^lab-favorite-75-100-[a-z0-9]{6}$/);
  assert.equal(first.strategy.name, "Lab favorites 75–100¢, La Liga + NBA");
  assert.deepEqual(first.strategy.settings, { pick: "favorite", min: 75, max: 100, entry: 3, from: 12, move: 2, spread: 5, leagues: "KXNBAGAME,KXLALIGAGAME", exec: "taker", exit: "result", exitH: 0, stake: "flat", size: 500, pct: 2, bank: 5000 });
  assert.equal(first.strategy.test?.bets, 61);
  // The same test again changes nothing; the same picks with another bet size update the one strategy.
  assert.equal(addStrategy(data, q(), { now: NOW }).outcome, "unchanged");
  assert.equal(addStrategy(data, q({ runs: 500, seed: 9, start: "2026-10-01" }), { now: NOW }).outcome, "unchanged", "simulation settings and test dates aren't part of the strategy");
  const resized = addStrategy(data, q({ size: 250 }), { now: new Date(NOW.getTime() + 1000) });
  assert.deepEqual([resized.outcome, resized.strategy.id, resized.strategy.rule.risk.max_position_usd, data.strategies.length], ["updated", first.strategy.id, 250, 1]);
  assert.equal(resized.strategy.test?.bets, 61, "the earlier test result is kept when no new one is given");
  // Different picks are a second strategy.
  assert.equal(addStrategy(data, q({ leagues: "KXNBAGAME" }), { now: NOW }).outcome, "added");
  assert.equal(data.strategies.length, 2);

  // Remove: no new bets, but the strategy stays known. Undo brings it back as it was.
  assert.equal(removeStrategy(data, first.strategy.id, NOW), true);
  assert.equal(removeStrategy(data, first.strategy.id, NOW), false);
  assert.equal(removeStrategy(data, "lab-nope", NOW), false);
  assert.deepEqual(activeStrategies(data).map((s) => s.name), ["Lab favorites 75–100¢, NBA"]);
  assert.equal(restoreStrategy(data, first.strategy.id).removedAt, undefined);
  assert.equal(activeStrategies(data).length, 2);
  assert.throws(() => restoreStrategy(data, "lab-nope"), LabStrategyError);
  // Adding a removed strategy again brings it back too.
  removeStrategy(data, first.strategy.id, NOW);
  assert.equal(addStrategy(data, q({ size: 250 }), { now: NOW }).outcome, "restored");

  // What the bot can't run is refused with the reason, and nothing is stored.
  for (const [over, why] of [[{ exec: "maker" }, /resting at the bid/], [{ exit: "pregame", exitH: 1 }, /sell at a set time/], [{ pick: "underdog", min: 5, max: 30 }, /underdog/]] as Array<[Record<string, unknown>, RegExp]>) {
    assert.throws(() => addStrategy(data, q(over), { now: NOW }), (err: Error) => err instanceof LabStrategyError && why.test(err.message));
  }
  // A rule with the same id in the rules file is already trading those games.
  assert.throws(() => addStrategy(emptyStrategies(), q(), { now: NOW, taken: new Set([first.strategy.id]) }), /already in your rules file/);
  assert.equal(data.strategies.length, 2);

  // A dozen at most trade at once; removed ones don't count.
  const full = emptyStrategies();
  for (let i = 0; i < MAX_LAB_STRATEGIES; i++) addStrategy(full, q({ min: 50 + i }), { now: NOW });
  assert.throws(() => addStrategy(full, q({ min: 70 }), { now: NOW }), /Remove one first/);
  removeStrategy(full, full.strategies[0].id, NOW);
  assert.equal(addStrategy(full, q({ min: 70 }), { now: NOW }).outcome, "added");
  assert.throws(() => restoreStrategy(full, full.strategies[0].id), /Remove one first/);

  // Settings from a request go through the same limits as a lab run.
  assert.deepEqual(parseSettings({ ...MINE, leagues: ["KXNBAGAME", "KXLALIGAGAME"] }), q());
  assert.throws(() => parseSettings({ pick: "everything" }), /Bad setting: pick/);
  assert.throws(() => parseSettings({ size: 1e12 }), /Bad setting: size/);
  assert.deepEqual(parseSettings(null), LabQuery.parse({}));
});

test("loading for a paper cycle: always paper, never a clash, and a bad entry doesn't take the rest down", async () => {
  const data = emptyStrategies();
  const a = addStrategy(data, q(), { now: NOW }).strategy;
  const b = addStrategy(data, q({ pick: "riser", min: 30, max: 95, entry: 1, leagues: "" }), { now: NOW }).strategy;
  const gone = addStrategy(data, q({ leagues: "KXNHLGAME" }), { now: NOW }).strategy;
  removeStrategy(data, gone.id, NOW);
  // Whatever a hand-edited file says, a lab strategy is a paper rule under its own id.
  (a.rule as { action: string }).action = "live";
  (a.rule as { id: string }).id = "something-else";
  const bad: string[] = [];
  const rules = labRules(data, new Set(), (s, why) => bad.push(`${s.id}: ${why}`));
  assert.deepEqual(rules.map((r) => [r.id, r.action, r.enabled]), [[a.id, "paper", true], [b.id, "paper", true], [gone.id, "paper", false]]);
  assert.deepEqual(rules[0].filters.leagues, ["laliga", "nba"]);
  assert.equal(rules[0].risk.max_open_positions, 10);
  assert.equal(bad.length, 0);

  // An id used by the rules file, an id outside the lab's prefix, a rule that doesn't load: each skipped with a reason.
  const messy: LabStrategyFile = JSON.parse(JSON.stringify(data));
  messy.strategies.push({ ...messy.strategies[1], id: "late-mover-paper" }, { ...messy.strategies[1], id: "lab-broken", rule: { ...messy.strategies[1].rule, risk: { bankroll_usd: -5 } as never } }, { ...messy.strategies[1] });
  const kept = labRules(messy, new Set([a.id]), (s, why) => bad.push(`${s.id}: ${why}`));
  assert.deepEqual(kept.map((r) => r.id), [b.id, gone.id]);
  assert.deepEqual(bad.map((m) => m.replace(/: .*/, "")), [a.id, "late-mover-paper", "lab-broken", b.id]);
  assert.match(bad[1], /must start with "lab-"/);
  assert.match(bad[2], /risk\.bankroll_usd/);

  // The file: next to the ledger, missing = empty, unreadable = an error (never quietly no strategies).
  const dir = await mkdtemp(path.join(tmpdir(), "prb-labs-"));
  const file = strategiesPathFor(path.join(dir, "paper-ledger.json"));
  assert.equal(path.basename(file), "paper-ledger.lab.json");
  assert.deepEqual(await loadStrategies(file), emptyStrategies());
  await saveStrategies(file, data);
  assert.deepEqual((await loadStrategies(file)).strategies.map((s) => s.id), data.strategies.map((s) => s.id));
  await writeFile(file, "{ not json");
  await assert.rejects(loadStrategies(file), /isn't valid JSON/);
  await writeFile(file, JSON.stringify({ version: 7, strategies: [] }));
  await assert.rejects(loadStrategies(file), /isn't a lab strategies file/);
});

function request(base: string, method: string, pathname: string, headers: Record<string, string> = {}, body: unknown = {}): Promise<{ status: number; json: Record<string, never> }> {
  const u = new URL(base + pathname);
  return new Promise((resolve, reject) => {
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: { Host: u.host, ...headers } }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, json: text.startsWith("{") ? JSON.parse(text) : {} }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined);
  });
}

/** A Kalshi game-winner market as the adapter would hand it over. */
const game = (id: string, league: string, bid: number, ask: number, startsInHours: number, over: Record<string, unknown> = {}) => ({
  platform: "kalshi",
  id,
  title: `${id.split("-").pop()} wins`,
  eventId: id.slice(0, id.lastIndexOf("-")),
  yesPrice: (bid + ask) / 2,
  yesBid: bid,
  yesAsk: ask,
  marketType: "game_winner",
  league,
  startsAt: new Date(NOW.getTime() + startsInHours * 3600_000).toISOString(),
  resolvesAt: new Date(NOW.getTime() + (startsInHours + 3) * 3600_000).toISOString(),
  ...over,
});

test("the button, end to end: add from the dashboard, it trades on paper, remove stops new bets, open bets still settle", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-labpaper-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(rules, "rules:\n  - id: a\n    name: A\n    entry: { yes_price_above: 0.5 }\n");
  const ledgerPath = path.join(dir, "ledger.json");
  const fixture = path.join(dir, "markets.json");
  const cycle = async (now: Date, markets: unknown[]) => {
    await writeFile(fixture, JSON.stringify(markets));
    return runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })] });
  };
  const ledger = async () => JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  const server = createDashboardServer({ ledgerPath, rulesPath: rules, demo: true });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const json = { "Content-Type": "application/json", Origin: base };
  type List = { outcome?: string; id?: string; error?: string; strategies: Array<{ id: string; name: string; removedAt?: string; risk: { max_position_usd: number }; settings: { size: number }; test?: unknown; notes: string[] }> };
  const post = async (body: unknown, headers: Record<string, string> = json) => {
    const r = await request(base, "POST", "/api/lab/strategy", headers, body);
    return { status: r.status, body: r.json as unknown as List };
  };
  try {
    // Only this page can add a strategy, and only with settings the lab accepts.
    assert.equal((await post({ action: "add", settings: MINE }, { ...json, Origin: "https://evil.example" })).status, 403);
    assert.equal((await post({ action: "add", settings: MINE }, { "Content-Type": "text/plain" })).status, 415);
    assert.equal((await post("{ nope")).status, 400);
    assert.equal((await post({ action: "launch" })).status, 400);
    assert.equal((await post({ action: "add", settings: { ...MINE, size: -4 } })).status, 409);
    const refused = await post({ action: "add", settings: { ...MINE, exec: "maker" } });
    assert.deepEqual([refused.status, /resting at the bid/.test(refused.body.error ?? "")], [409, true]);
    assert.equal((await post({ action: "remove", id: "lab-nothing" })).status, 404);
    await assert.rejects(readFile(strategiesPathFor(ledgerPath), "utf8"), "nothing is written by a refused request");

    // Add it. The browser sends settings; the rule is built here.
    const added = await post({ action: "add", settings: { ...MINE, rule: { action: "live" }, id: "evil" } });
    assert.deepEqual([added.status, added.body.outcome, added.body.strategies.length], [200, "added", 1]);
    const id = added.body.id!;
    assert.match(id, /^lab-favorite-75-100-/);
    assert.equal(added.body.strategies[0].test, undefined, "no game history here, so no test result to keep");
    const stored = JSON.parse(await readFile(strategiesPathFor(ledgerPath), "utf8")) as LabStrategyFile;
    assert.deepEqual([stored.strategies[0].rule.action, stored.strategies[0].rule.id], ["paper", id]);
    assert.equal((await post({ action: "add", settings: MINE })).body.outcome, "unchanged");
    const listed = (await request(base, "GET", "/api/lab/strategies")).json as unknown as List & { max: number };
    assert.deepEqual([listed.max, listed.strategies.map((s) => s.id)], [MAX_LAB_STRATEGIES, [id]]);
    // It's on the Strategies page before its first bet, like any other paper strategy.
    type State = { rules: Array<{ ruleId: string; name: string; enabled: boolean; stopped: boolean; open: number; closed: number; realizedPnlUsd: number }>; lab: { strategies: string[] } };
    const state = async () => (await request(base, "GET", "/api/state")).json as unknown as State;
    const row = async () => (await state()).rules.find((r) => r.ruleId === id)!;
    assert.deepEqual([(await row()).name, (await row()).enabled, (await state()).lab.strategies], ["Lab favorites 75–100¢, La Liga + NBA", true, [id]]);

    // One check: only NBA and La Liga favorites in the range, about three hours before the start.
    const BOS = "KXNBAGAME-26NOV10BOSNYK-BOS";
    const RMA = "KXLALIGAGAME-26NOV10RMABAR-RMA";
    const first = await cycle(NOW, [
      game(BOS, "nba", 0.79, 0.81, 3),
      game(RMA, "laliga", 0.9, 0.92, 2.6),
      game("KXNHLGAME-26NOV10TORMTL-TOR", "nhl", 0.79, 0.81, 3), // not a league in the test
      game("KXNBAGAME-26NOV10LALGSW-LAL", "nba", 0.79, 0.81, 6), // too early
      game("KXNBAGAME-26NOV10MIAORL-MIA", "nba", 0.79, 0.81, 1), // too late
      game("KXNBAGAME-26NOV10DENUTA-DEN", "nba", 0.59, 0.61, 3), // below the range
      game("KXNBAGAME-26NOV10PHXSAC-PHX", "nba", 0.74, 0.86, 3), // book too wide
      game("KXNBASPREAD-26NOV10CHIDET-CHI4", "nba", 0.79, 0.81, 3, { marketType: "other" }), // not a game winner
    ]);
    assert.equal(first.opened, 2);
    const open = (await ledger()).positions.filter((p) => p.status === "open");
    assert.deepEqual(open.map((p) => [p.ruleId, p.marketId, p.side]).sort(), [[id, RMA, "yes"], [id, BOS, "yes"]].sort());
    for (const p of open) assert.ok(p.costUsd > 480 && p.costUsd <= 500, `$500 a bet, got ${p.costUsd}`);
    assert.deepEqual([(await row()).open, (await row()).closed], [2, 0]);

    // The Strategies switch works on it like on any other.
    assert.equal((await request(base, "POST", "/api/control", json, JSON.stringify({ action: "stop", id }))).status, 200);
    const DAL = "KXNBAGAME-26NOV10DALHOU-DAL";
    const later = new Date(NOW.getTime() + 60_000);
    assert.equal((await cycle(later, [game(BOS, "nba", 0.79, 0.81, 3), game(RMA, "laliga", 0.9, 0.92, 2.6), game(DAL, "nba", 0.84, 0.86, 3)])).opened, 0);
    assert.equal((await request(base, "POST", "/api/control", json, JSON.stringify({ action: "start", id }))).status, 200);

    // Remove it: no new bets, even on a game that fits. The open ones stay, and settle under its name.
    const removed = await post({ action: "remove", id });
    assert.deepEqual([removed.status, removed.body.outcome, !!removed.body.strategies[0].removedAt], [200, "removed", true]);
    assert.deepEqual((await state()).lab.strategies, []);
    const settled = await cycle(new Date(NOW.getTime() + 120_000), [
      game(BOS, "nba", 0.99, 1, -4, { status: "resolved", resolvedOutcome: "yes", yesPrice: 1 }),
      game(RMA, "laliga", 0.9, 0.92, 2.6),
      game(DAL, "nba", 0.84, 0.86, 3),
    ]);
    assert.deepEqual([settled.opened, settled.closed], [0, 1]);
    const after = await row();
    assert.deepEqual([after.enabled, after.open, after.closed, after.realizedPnlUsd > 0], [false, 1, 1, true]);

    // Undo: it trades again, same strategy, same history.
    const back = await post({ action: "restore", id });
    assert.deepEqual([back.status, back.body.outcome, back.body.strategies[0].removedAt], [200, "restored", undefined]);
    assert.equal((await cycle(new Date(NOW.getTime() + 180_000), [game(RMA, "laliga", 0.9, 0.92, 2.6), game(DAL, "nba", 0.84, 0.86, 3)])).opened, 1);
    assert.deepEqual([(await row()).enabled, (await row()).open, (await row()).closed], [true, 2, 1]);
    // A new bet size updates it in place.
    const resized = await post({ action: "add", settings: { ...MINE, size: 250 } });
    assert.deepEqual([resized.body.outcome, resized.body.strategies.length, resized.body.strategies[0].risk.max_position_usd, resized.body.strategies[0].settings.size], ["updated", 1, 250, 250]);

    // A busy day: the rules look at the first few markets only, but a league strategy still sees its league's games.
    const SAS = "KXNBAGAME-26NOV10SASCHI-SAS";
    const crowd = ["A", "B", "C", "D", "E", "F"].map((x) => game(`KXNCAAFGAME-26NOV10TEAM${x}OPP-TEAM${x}`, "cfb", 0.79, 0.81, 1));
    await writeFile(fixture, JSON.stringify([...crowd, game(SAS, "nba", 0.79, 0.81, 3)]));
    const busy = await runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now: new Date(NOW.getTime() + 200_000), emit: () => undefined, limitPerPlatform: 2, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => NOW })] });
    assert.equal(busy.opened, 1);
    assert.ok((await ledger()).positions.some((p) => p.marketId === SAS && p.ruleId === id && p.status === "open"));

    // A strategies file that can't be read is said out loud, and the user's own rules keep trading.
    await writeFile(strategiesPathFor(ledgerPath), "{ broken");
    assert.equal((await request(base, "GET", "/api/lab/strategies")).status, 500);
    assert.equal((await post({ action: "add", settings: MINE })).status, 500);
    assert.match(((await request(base, "GET", "/api/state")).json as unknown as { lab: { error: string } }).lab.error, /isn't valid JSON/);
    const events: string[] = [];
    await writeFile(fixture, JSON.stringify([game(DAL, "nba", 0.84, 0.86, 3)]));
    await runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now: new Date(NOW.getTime() + 240_000), emit: (e) => void events.push(`${e.type}: ${e.message}`), adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => NOW })] });
    assert.ok(events.some((e) => /^adapter_error: Lab strategies skipped: .*isn't valid JSON/.test(e)), events.join("\n"));
    assert.ok(events.some((e) => e.startsWith("scan_end")), "the cycle still finished");
  } finally {
    server.close();
  }
});
