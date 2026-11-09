import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { devig, fairFor, namesTeam, sportOf, type SharpEvent } from "./sharp.js";
import { fetchOdds, OddsApiError, parseOddsEvents, type FetchLike, type RawOddsEvent } from "./odds-api.js";
import { loadSharp, loadSharpState } from "./runtime.js";
import { RuleSchema, SharpLinesSchema } from "../rules/schema.js";
import { traceEntry } from "../engine/evaluate.js";
import { runPaperCycle } from "../engine/paper-session.js";
import { DemoAdapter } from "../platforms/demo.js";
import type { PaperLedger } from "../ledger/paper.js";
import type { NormalizedMarket } from "../types.js";

const NOW = new Date("2026-11-15T17:00:00Z");
const START = "2026-11-15T18:00:00Z";
const H = 3600_000;

const km = (code: string, sub: string, bid: number, ask: number, over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform: "kalshi",
  id: `KXNFLGAME-26NOV15BUFMIN-${code}`,
  eventId: "KXNFLGAME-26NOV15BUFMIN",
  title: `${sub} wins`,
  subtitle: sub,
  yesPrice: (bid + ask) / 2,
  yesBid: bid,
  yesAsk: ask,
  marketType: "game_winner",
  startsAt: START,
  resolvesAt: "2026-11-15T21:00:00Z",
  ...over,
});
const row = (books: Array<[string, Array<[string, number]>, string?]>, over: Partial<RawOddsEvent> = {}): RawOddsEvent => ({
  sport_key: "americanfootball_nfl",
  commence_time: START,
  home_team: "Minnesota Vikings",
  away_team: "Buffalo Bills",
  bookmakers: books.map(([key, outs, at]) => ({ key, last_update: at ?? "2026-11-15T16:50:00Z", markets: [{ key: "h2h", last_update: at ?? "2026-11-15T16:50:00Z", outcomes: outs.map(([name, price]) => ({ name, price })) }] })),
  ...over,
});
const PIN: [string, Array<[string, number]>] = ["pinnacle", [["Buffalo Bills", 1.5], ["Minnesota Vikings", 2.75]]];

test("margin removal: implied probabilities scaled to sum to one", () => {
  const [a, b] = devig([1.5, 2.75]);
  assert.equal(+(a + b).toFixed(9), 1);
  assert.equal(+a.toFixed(4), 0.6471); // (1/1.5) / (1/1.5 + 1/2.75)
  assert.deepEqual(devig([1, 2]), []);
});

test("team names: exchange short names against a sportsbook's full names", () => {
  assert.ok(namesTeam("Buffalo", "Buffalo Bills"));
  assert.ok(namesTeam("Bills", "Buffalo Bills"));
  assert.ok(namesTeam("Los Angeles L", "Los Angeles Lakers"));
  assert.ok(!namesTeam("Los Angeles L", "Los Angeles Clippers"));
  assert.ok(namesTeam("Ohio St.", "Ohio State Buckeyes"));
  assert.ok(namesTeam("Man City", "Manchester City"));
  assert.ok(!namesTeam("Minnesota", "Buffalo Bills"));
  assert.ok(!namesTeam("NY", "New York Knicks"), "too short to trust");
  assert.ok(!namesTeam("State", "Ohio State Buckeyes"), "a middle word isn't a name");
});

test("odds rows: the sharp book's own line, else the median of 4+ books, else nothing", () => {
  const [e] = parseOddsEvents([row([PIN, ["other", [["Buffalo Bills", 1.4], ["Minnesota Vikings", 3]]]])]);
  assert.equal(e.book, "pinnacle");
  assert.equal(+e.fair["Buffalo Bills"].toFixed(4), 0.6471);
  const four = ["a", "b", "c", "d"].map((k, i): [string, Array<[string, number]>] => [k, [["Buffalo Bills", 1.5 + i * 0.02], ["Minnesota Vikings", 2.7]]]);
  const [c] = parseOddsEvents([row(four)]);
  assert.equal(c.book, "consensus of 4 books");
  assert.equal(+(c.fair["Buffalo Bills"] + c.fair["Minnesota Vikings"]).toFixed(9), 1);
  assert.equal(parseOddsEvents([row(four.slice(0, 3))]).length, 0, "three ordinary books aren't a sharp line");
  // Soccer keeps the draw.
  const [s] = parseOddsEvents([row([["pinnacle", [["Arsenal", 2], ["Chelsea", 4], ["Draw", 3.6]]]], { sport_key: "soccer_epl", home_team: "Arsenal", away_team: "Chelsea" })]);
  assert.equal(+(s.fair.Arsenal + s.fair.Chelsea + s.fair.Draw).toFixed(9), 1);
});

const EVENTS = parseOddsEvents([row([PIN])]);
const buf = km("BUF", "Buffalo", 0.58, 0.6);
const min = km("MIN", "Minnesota", 0.4, 0.42);

test("fair value for a market: same league, start time, and BOTH teams named, or it's skipped", () => {
  assert.equal(sportOf(buf), "americanfootball_nfl");
  const f = fairFor(buf, [buf, min], EVENTS);
  assert.ok("p" in f && +f.p.toFixed(4) === 0.6471 && f.book === "pinnacle");
  const g = fairFor(min, [buf, min], EVENTS);
  assert.ok("p" in g && +g.p.toFixed(4) === 0.3529);
  // The other team's market isn't in view: no guess.
  assert.match((fairFor(buf, [buf], EVENTS) as { reason: string }).reason, /both teams/);
  // A different day's game between the same teams.
  assert.match((fairFor(km("BUF", "Buffalo", 0.58, 0.6, { startsAt: "2026-11-22T18:00:00Z" }), [buf, min], EVENTS) as { reason: string }).reason, /no sharp line/);
  // Team names that don't match the book's.
  const odd = km("BUF", "Bison", 0.58, 0.6);
  assert.match((fairFor(odd, [odd, min], EVENTS) as { reason: string }).reason, /don't line up/);
  // Two games that both fit: skipped.
  assert.match((fairFor(buf, [buf, min], [...EVENTS, ...EVENTS]) as { reason: string }).reason, /more than one/);
  // Polymarket US: the YES team comes from the market's own sides.
  const us: NormalizedMarket = { platform: "polymarket_us", id: "1", title: "x", yesPrice: 0.4, startsAt: START, raw: { slug: "aec-nfl-buf-min-2026-11-15", marketSides: [{ long: true, team: { name: "Minnesota Vikings" } }, { long: false, team: { name: "Buffalo Bills" } }] } };
  const u = fairFor(us, [us], EVENTS);
  assert.ok("p" in u && +u.p.toFixed(4) === 0.3529);
  // Soccer: the tie market gets the draw.
  const soccer = parseOddsEvents([row([["pinnacle", [["Arsenal", 2], ["Chelsea", 4], ["Draw", 3.6]]]], { sport_key: "soccer_epl", home_team: "Arsenal", away_team: "Chelsea" })]);
  const s = (code: string, sub: string) => km(code, sub, 0.2, 0.22, { id: `KXEPLGAME-26NOV15ARSCHE-${code}`, eventId: "KXEPLGAME-26NOV15ARSCHE" });
  const sides = [s("ARS", "Arsenal"), s("CHE", "Chelsea"), s("TIE", "Tie")];
  const t = fairFor(sides[2], sides, soccer);
  assert.ok("p" in t && +t.p.toFixed(4) === +soccer[0].fair.Draw.toFixed(4));
});

const rule = (entry: Record<string, unknown> = {}) =>
  RuleSchema.parse({ id: "sharp", name: "sharp", action: "paper", filters: { market_types: ["game_winner"], pre_game_only: true }, entry: { side: "with_move", sharp_edge: {}, ...entry }, risk: { fire_after_n_losses: 0 } });
const fair = (p: number, ageMin = 10) => ({ p, book: "pinnacle", updatedAt: new Date(NOW.getTime() - ageMin * 60_000).toISOString(), game: "Buffalo Bills at Minnesota Vikings" });
const sharpCheck = (t: ReturnType<typeof traceEntry>) => t.checks.find((c) => c.name === "Sharp line")!;

test("sharp edge: buys the side that costs 3¢+ less than the sharp line says, after the fee", () => {
  // Fair 64.7¢, ask 60¢, fee 0.07 × 0.6 × 0.4 = 1.7¢ → +3.0¢.
  const yes = traceEntry(rule(), buf, undefined, NOW, { fair: fair(0.6471) });
  assert.equal(yes.match?.side, "yes");
  assert.match(sharpCheck(yes).detail, /pinnacle makes YES worth 64\.7¢; it costs 60¢ here = \+3¢ after the fee/);
  // Priced right: nothing to do.
  assert.equal(traceEntry(rule(), km("BUF", "Buffalo", 0.63, 0.65), undefined, NOW, { fair: fair(0.6471) }).match, null);
  // The other side is the cheap one: with_move buys NO.
  const no = traceEntry(rule(), km("BUF", "Buffalo", 0.7, 0.72), undefined, NOW, { fair: fair(0.6471) });
  assert.equal(no.match?.side, "no");
  // side: yes never buys NO.
  assert.equal(traceEntry(rule({ side: "yes" }), km("BUF", "Buffalo", 0.7, 0.72), undefined, NOW, { fair: fair(0.6471) }).match, null);
});

test("sharp edge: an old line, a too-good edge and a missing line are all refusals", () => {
  assert.match(sharpCheck(traceEntry(rule(), buf, undefined, NOW, { fair: fair(0.6471, 90) })).detail, /90 min old \(max 60\)/);
  assert.match(sharpCheck(traceEntry(rule(), km("BUF", "Buffalo", 0.38, 0.4), undefined, NOW, { fair: fair(0.6471) })).detail, /wrong match or old news/);
  assert.match(sharpCheck(traceEntry(rule(), buf, undefined, NOW, { fairWhy: "no sharp line: add ODDS_API_KEY to .env" })).detail, /ODDS_API_KEY/);
});

const fakeFetch = (rows: RawOddsEvent[], calls: string[], remaining = 480): FetchLike => async (url) => {
  calls.push(url);
  return { status: 200, ok: true, headers: { get: (h) => (h === "x-requests-last" ? "1" : h === "x-requests-remaining" ? String(remaining) : null) }, json: async () => rows };
};

test("request budget: only when a game starts soon, at most once per refresh, never past the daily cap; cached across runs", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-sharp-"));
  const file = path.join(dir, "ledger.sharp.json");
  const cfg = SharpLinesSchema.parse({ max_credits_per_day: 2 });
  const calls: string[] = [];
  const deps = { key: "SECRET", fetchImpl: fakeFetch([row([PIN])], calls) };
  const far = [km("BUF", "Buffalo", 0.58, 0.6, { startsAt: new Date(NOW.getTime() + 9 * H).toISOString() }), km("MIN", "Minnesota", 0.4, 0.42, { startsAt: new Date(NOW.getTime() + 9 * H).toISOString() })];
  await loadSharp(cfg, [rule()], far, file, NOW, deps);
  assert.equal(calls.length, 0, "nothing starts within 2 hours");
  const at = (h: number) => ({ startsAt: new Date(NOW.getTime() + h * H).toISOString() });
  const soon = [km("BUF", "Buffalo", 0.58, 0.6, at(1.9)), km("MIN", "Minnesota", 0.4, 0.42, at(1.9))];
  const r1 = await loadSharp(cfg, [rule()], soon, file, NOW, deps);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /sports\/americanfootball_nfl\/odds\?regions=eu&markets=h2h/);
  assert.equal(r1.fair.size, 2);
  assert.match(r1.notes[0], /1 game\(s\), 480 requests left this month/);
  // Ten minutes later: served from the cache.
  await loadSharp(cfg, [rule()], soon, file, new Date(NOW.getTime() + 10 * 60_000), deps);
  assert.equal(calls.length, 1);
  // An hour later: one more request; after that the day's cap holds.
  await loadSharp(cfg, [rule()], soon, file, new Date(NOW.getTime() + 65 * 60_000), deps);
  assert.equal(calls.length, 2);
  const late = [km("BUF", "Buffalo", 0.58, 0.6, { startsAt: new Date(NOW.getTime() + 4 * H).toISOString() }), km("MIN", "Minnesota", 0.4, 0.42, { startsAt: new Date(NOW.getTime() + 4 * H).toISOString() })];
  const r4 = await loadSharp(cfg, [rule()], late, file, new Date(NOW.getTime() + 2.5 * H), deps);
  assert.equal(calls.length, 2);
  assert.match(r4.notes[0], /today's 2 requests are used/);
  assert.equal((await loadSharpState(file)).usedToday, 2);
  // Quick checks never spend a request; no key means no request and a clear reason.
  const none = await loadSharp(cfg, [rule()], [buf, min], path.join(dir, "other.json"), NOW, { key: "", fetchImpl: deps.fetchImpl });
  assert.equal(calls.length, 2);
  assert.match(none.why.get(`kalshi:${buf.id}`)!, /add ODDS_API_KEY/);
  assert.ok(!(await readFile(file, "utf8")).includes("SECRET"), "the key is never written to disk");
});

test("the key never appears in an error, and a bad key stops the asking for a while", async () => {
  const boom: FetchLike = async (url) => {
    throw new Error(`connect failed for ${url}`);
  };
  await assert.rejects(fetchOdds("basketball_nba", "SECRET", { fetchImpl: boom }), (e: OddsApiError) => !e.message.includes("SECRET") && /couldn't reach/.test(e.message));
  const dir = await mkdtemp(path.join(tmpdir(), "prb-sharp2-"));
  const file = path.join(dir, "s.json");
  let n = 0;
  const bad: FetchLike = async () => {
    n++;
    return { status: 401, ok: false, headers: { get: () => null }, json: async () => ({ error_code: "INVALID_KEY", message: "bad" }) };
  };
  const cfg = SharpLinesSchema.parse({});
  const r = await loadSharp(cfg, [rule()], [buf, min], file, NOW, { key: "SECRET", fetchImpl: bad });
  assert.match(r.problems[0], /the key in ODDS_API_KEY isn't valid/);
  const again = await loadSharp(cfg, [rule()], [buf, min], file, new Date(NOW.getTime() + 5 * 60_000), { key: "SECRET", fetchImpl: bad });
  assert.equal(n, 1, "not asked again five minutes later");
  assert.match(again.why.get(`kalshi:${buf.id}`)!, /isn't valid/);
});

test("paper: the sharp-line rule buys the underpriced side once per game, sized by the per-trade loss cap", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-sharp3-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `sharp_lines: { enabled: true }
rules:
  - id: sharp
    name: Sharp line
    action: paper
    filters: { platforms: [kalshi], market_types: [game_winner], max_spread: 0.04, pre_game_only: true }
    entry: { side: with_move, sharp_edge: { min_edge: 0.03 } }
    risk: { fire_after_n_losses: 0, position_size_fraction: 0.05, max_position_usd: 50, max_loss_per_trade_usd: 20 }
`,
  );
  const fixture = path.join(dir, "k.json");
  await writeFile(fixture, JSON.stringify([buf, min]));
  const calls: string[] = [];
  const ledgerPath = path.join(dir, "ledger.json");
  const run = (now: Date) =>
    runPaperCycle({ rulesPath: rules, ledgerPath, demo: true, now, emit: () => undefined, adapters: [new DemoAdapter("kalshi", { fixturePath: fixture, now: () => now })], sharpDeps: { key: "K", fetchImpl: fakeFetch([row([PIN])], calls) } });
  const r = await run(NOW);
  assert.equal(r.opened, 1);
  const pos = (JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger).positions[0];
  assert.equal(pos.marketId, buf.id);
  assert.equal(pos.side, "yes");
  assert.ok(pos.costUsd <= 20 && pos.costUsd > 19, `whole stake at risk, so the stake is capped at $20 (got ${pos.costUsd})`);
  assert.equal(Date.parse(pos.startsAt!), Date.parse(START), "tracked for its closing price");
  assert.equal((await run(new Date(NOW.getTime() + 5 * 60_000))).opened, 0);
  assert.equal(calls.length, 1);
});
