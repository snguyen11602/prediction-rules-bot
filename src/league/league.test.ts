import { test } from "node:test";
import assert from "node:assert/strict";
import { RuleSchema } from "../rules/schema.js";
import { LeagueSchema } from "../rules/schema.js";
import { diagnose } from "./diagnose.js";
import { describeRule, MIN_HOLD_HOURS, MIN_REWARD_RISK, mutate, rookieRule, type FamilyId } from "./genome.js";
import { familyAllowed, leagueRules, memberRule, migrateNames, scoreOf, upgradeLeague, type LeagueFile, type Member } from "./league.js";
import { statsFromTrades, tradesByRule, type TradeResult } from "./metrics.js";
import { baseName, cloneName, hashSeed, housePersonas, inheritTraits, NAMES, randomTraits, rng, rookieName } from "./personas.js";
import { makeClone, makeRookie, type Contestant } from "./evolve.js";
import type { PaperLedger } from "../ledger/paper.js";

const FAMS: Exclude<FamilyId, "custom">[] = ["dip_buyer", "momentum", "favorite", "longshot_fade", "scalper"];

test("personas are deterministic, unique and bounded", () => {
  const a = rng(42);
  const b = rng(42);
  assert.deepEqual([a(), a(), a()], [b(), b(), b()]);
  const r = rng(hashSeed("x"));
  const taken = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const n = rookieName(r, taken);
    assert.ok(!taken.has(n), `duplicate name ${n}`);
    assert.match(n, /^[A-Z][a-z]+$/, "one short word");
    assert.ok(n.length <= 8);
    taken.add(n);
  }
  const t = randomTraits(r);
  for (let i = 0; i < 200; i++) {
    const c = inheritTraits({ hustle: 0.95, creativity: 0.05, knowledge: 0.5 }, r);
    for (const v of Object.values(c)) assert.ok(v >= 0.05 && v <= 0.95);
  }
  assert.ok(t.hustle >= 0.2 && t.hustle <= 0.8);
  assert.equal(baseName("Blaze III"), "Blaze");
  assert.equal(cloneName("Blaze", new Set(["Blaze"])), "Blaze II");
  assert.equal(cloneName("Blaze II", new Set(["Blaze", "Blaze II"])), "Blaze III");
  // Every word taken: still a unique name.
  const all = new Set(NAMES);
  const extra = rookieName(r, all);
  assert.ok(!all.has(extra) && / II$/.test(extra));
  const a1 = housePersonas(["my-rule", "other"]);
  const a2 = housePersonas(["other", "my-rule", "third"]);
  assert.equal(a1.get("my-rule")!.name, housePersonas(["my-rule", "other"]).get("my-rule")!.name, "your rules always get the same name");
  assert.notEqual(a2.get("my-rule")!.name, a2.get("other")!.name);
  assert.ok(NAMES.includes(a1.get("my-rule")!.name));
});

test("every rookie family makes a valid rule, and clones stay valid", () => {
  const r = rng(7);
  for (const f of FAMS) {
    for (let i = 0; i < 20; i++) {
      const traits = randomTraits(r);
      const body = rookieRule(f, traits, r);
      assert.doesNotThrow(() => RuleSchema.parse({ ...body, id: "x", name: "x" }));
      assert.equal(body.action, "paper");
      assert.ok(body.risk.max_position_usd! <= 50);
      const child = mutate(body, { ...traits, creativity: 0.95 }, inheritTraits(traits, r), r);
      assert.doesNotThrow(() => RuleSchema.parse({ ...child, id: "y", name: "y" }));
      if (child.filters.min_price != null && child.filters.max_price != null) assert.ok(child.filters.min_price < child.filters.max_price);
      assert.ok(describeRule(child).length >= 3);
    }
  }
});

test("work ethic and knowledge shape the rule", () => {
  const lazy = rookieRule("momentum", { hustle: 0.1, creativity: 0.5, knowledge: 0.1 }, rng(1));
  const busy = rookieRule("momentum", { hustle: 0.9, creativity: 0.5, knowledge: 0.9 }, rng(1));
  assert.ok(busy.risk.max_open_positions > lazy.risk.max_open_positions);
  assert.ok(busy.risk.reentry_cooldown_hours < lazy.risk.reentry_cooldown_hours);
  assert.ok(busy.filters.max_spread! < lazy.filters.max_spread!);
  assert.ok(busy.filters.keywords_exclude?.length && !lazy.filters.keywords_exclude);
});

test("a careful parent's clone stays closer than a creative parent's", () => {
  const r = rng(3);
  const traits = { hustle: 0.5, creativity: 0.5, knowledge: 0.5 };
  const parent = rookieRule("dip_buyer", traits, r);
  const drift = (creativity: number) => {
    let sum = 0;
    for (let i = 0; i < 200; i++) {
      const c = mutate(parent, { ...traits, creativity }, traits, r);
      sum += Math.abs(c.entry.yes_price_move_abs! - parent.entry.yes_price_move_abs!);
    }
    return sum;
  };
  assert.ok(drift(0.05) < drift(0.95));
});

function trade(enteredAt: string, exitedAt: string, pnlUsd: number, reason = "take_profit", feesUsd = 0.5): TradeResult {
  return { enteredAt, exitedAt, pnlUsd, feesUsd, reason };
}

test("stats: win rate, worst drop and steady score", () => {
  const s = statsFromTrades(
    [
      trade("2026-10-01T00:00:00Z", "2026-10-01T02:00:00Z", 30),
      trade("2026-10-02T00:00:00Z", "2026-10-02T04:00:00Z", -50, "stop_loss"),
      trade("2026-10-03T00:00:00Z", "2026-10-03T01:00:00Z", 40),
    ],
    { bankrollUsd: 1000, minTrades: 3 },
  );
  assert.equal(s.trades, 3);
  assert.equal(s.wins, 2);
  assert.equal(s.pnlUsd, 20);
  assert.equal(s.maxDrawdownUsd, 50);
  assert.equal(s.returnPct, 2);
  assert.equal(s.steadyScore, -3); // 2% made, 5% worst drop
  assert.equal(s.avgHoldHours, 2.3);
  assert.equal(s.exits.stop_loss, 1);
  assert.ok(s.ranked);
  assert.ok(!statsFromTrades([], { bankrollUsd: 1000, minTrades: 1 }).ranked);
});

test("an arbitrage counts as one trade", () => {
  const ledger = {
    positions: [
      { ruleId: "arbitrage", groupId: "g", status: "closed", exitAt: "2026-10-02T00:00:00Z", entryAt: "2026-10-01T00:00:00Z", realizedPnlUsd: 1, entryFeeUsd: 0.1, exitFeeUsd: 0 },
      { ruleId: "arbitrage", groupId: "g", status: "closed", exitAt: "2026-10-02T00:00:00Z", entryAt: "2026-10-01T00:00:00Z", realizedPnlUsd: 2, entryFeeUsd: 0.1, exitFeeUsd: 0 },
      { ruleId: "r1", status: "closed", exitAt: "2026-10-02T00:00:00Z", entryAt: "2026-10-01T00:00:00Z", realizedPnlUsd: 5, entryFeeUsd: 0.2, exitFeeUsd: 0.1, exitReason: "resolved" },
    ],
    arbGroups: { g: { id: "g", ruleId: "arbitrage", status: "closed", openedAt: "2026-10-01T00:00:00Z", closedAt: "2026-10-02T00:00:00Z", realizedPnlUsd: 3, closeReason: "resolved" } },
  } as unknown as PaperLedger;
  const by = tradesByRule(ledger);
  assert.equal(by.get("arbitrage")?.length, 1);
  assert.equal(by.get("arbitrage")?.[0].pnlUsd, 3);
  assert.ok(Math.abs(by.get("r1")![0].feesUsd - 0.3) < 1e-9);
});

test("diagnosis explains why a strategy didn't work", () => {
  const empty = statsFromTrades([], { bankrollUsd: 1000, minTrades: 5 });
  const never = diagnose(empty, { minTrades: 5, blocks: { checks: 1000, signals: 0, blocked: { "Price band": 900, Spread: 100 } } });
  assert.match(never.headline, /Never found a trade: "Price band" ruled out 90%/);
  assert.match(never.suggestion, /widen its price range/);

  const feeTrades = Array.from({ length: 6 }, (_, i) => trade(`2026-10-0${i + 1}T00:00:00Z`, `2026-10-0${i + 1}T01:00:00Z`, -1, "max_hold", 3));
  const fees = diagnose(statsFromTrades(feeTrades, { bankrollUsd: 1000, minTrades: 5 }), { minTrades: 5 });
  assert.match(fees.headline, /Fees ate the edge/);

  const lucky = statsFromTrades([trade("2026-10-01T00:00:00Z", "2026-10-01T01:00:00Z", 50)], { bankrollUsd: 1000, minTrades: 1 });
  const test2 = statsFromTrades([trade("2026-10-09T00:00:00Z", "2026-10-09T01:00:00Z", -20)], { bankrollUsd: 1000, minTrades: 1 });
  assert.match(diagnose(lucky, { minTrades: 1, test: test2 }).headline, /lost .* in the held-out last part/);

  const stops = Array.from({ length: 6 }, (_, i) => trade(`2026-10-0${i + 1}T00:00:00Z`, `2026-10-0${i + 1}T01:00:00Z`, i % 3 ? -10 : 5, "stop_loss", 0));
  assert.ok(diagnose(statsFromTrades(stops, { bankrollUsd: 1000, minTrades: 5 }), { minTrades: 5 }).findings.some((f) => /Stopped out/.test(f)));
});

test("score: backtest first, blended with paper once there are 10 paper trades", () => {
  const mk = (n: number, pnl: number) =>
    statsFromTrades(Array.from({ length: n }, (_, i) => trade(`2026-10-01T0${i % 10}:00:00Z`, `2026-10-01T0${i % 10}:30:00Z`, pnl)), { bankrollUsd: 1000, minTrades: 5 });
  const bt = { all: mk(6, 10) }; // +6%
  assert.deepEqual(scoreOf(bt, mk(3, -10)), { score: 6, ranked: true });
  const blended = scoreOf(bt, mk(10, -1)); // paper: −1% and a 1% drop
  assert.equal(blended.score, (6 + -2) / 2);
  assert.equal(scoreOf(undefined, mk(2, 1)).ranked, false);
  // Ranked on the part before the held-out test.
  assert.equal(scoreOf({ all: mk(6, 10), train: mk(3, -10) }, mk(0, 0)).score, -6);
});

function member(over: Partial<Member> = {}): Member {
  const traits = { hustle: 0.5, creativity: 0.5, knowledge: 0.5 };
  return {
    id: "lg-ava-sterling-1",
    name: "Ava Sterling",
    style: "The Dip Hunter",
    family: "dip_buyer",
    traits,
    rule: rookieRule("dip_buyer", traits, rng(1)),
    generation: 1,
    bornAt: "2026-10-01T00:00:00Z",
    status: "active",
    ...over,
  };
}

test("league members become normal paper rules; retired ones only manage exits", () => {
  const l: LeagueFile = { version: 1, round: 1, members: [member(), member({ id: "lg-x-2", name: "Milo Vance", status: "retired" })], events: [] };
  const rules = leagueRules(l, LeagueSchema.parse({ families: ["dip_buyer"] }));
  assert.equal(rules.length, 2);
  assert.equal(rules[0].name, "Ava Sterling — The Dip Hunter");
  assert.equal(rules[0].action, "paper");
  assert.equal(rules[0].enabled, true);
  assert.equal(rules[1].enabled, false);
  // Switched off in the rules file: nothing new is entered.
  assert.ok(leagueRules(l, LeagueSchema.parse({ enabled: false })).every((r) => !r.enabled));
  assert.equal(memberRule(member()).id, "lg-ava-sterling-1");
});

test("rookies cycle through families; clones carry the family name and a similar personality", () => {
  const cfg = LeagueSchema.parse({});
  const l: LeagueFile = { version: 1, round: 0, members: [], events: [] };
  const r = rng(11);
  for (let i = 0; i < 10; i++) l.members.push(makeRookie(l, cfg, r, new Date("2026-10-01T00:00:00Z")));
  const fams = new Map<string, number>();
  for (const m of l.members) fams.set(m.family, (fams.get(m.family) ?? 0) + 1);
  assert.deepEqual([...fams.keys()].sort(), ["favorite", "longshot_fade", "momentum"], "dip hunters and scalpers are off by default");
  assert.deepEqual([...fams.values()].sort(), [3, 3, 4]);
  assert.equal(new Set(l.members.map((m) => m.id)).size, 10);

  const parent = l.members[0];
  const c: Contestant = {
    id: parent.id, name: parent.name, style: parent.style, house: false, member: parent, traits: parent.traits, rule: parent.rule,
    paper: statsFromTrades([], { bankrollUsd: 1000, minTrades: 5 }), score: 5, ranked: true, eligible: true,
    diagnosis: { at: "", headline: "", findings: [], suggestion: "" },
  };
  const kid = makeClone(l, c, r, new Date("2026-10-02T00:00:00Z"));
  assert.equal(kid.name, `${parent.name} II`);
  assert.equal(makeClone(l, c, r, new Date("2026-10-02T00:00:00Z")).name, `${parent.name} II`, "names are only taken once added");
  assert.equal(kid.parentId, parent.id);
  assert.equal(kid.generation, 2);
  assert.equal(kid.family, parent.family);
  for (const k of ["hustle", "creativity", "knowledge"] as const) assert.ok(Math.abs(kid.traits[k] - parent.traits[k]) <= 0.1 + 1e-9);
});

test("member ids never repeat, even after old members leave the file", () => {
  const cfg = LeagueSchema.parse({});
  const l: LeagueFile = { version: 1, round: 0, members: [], events: [] };
  const r = rng(2);
  const now = new Date("2026-10-01T00:00:00Z");
  for (let i = 0; i < 5; i++) l.members.push(makeRookie(l, cfg, r, now));
  const seen = new Set(l.members.map((m) => m.id));
  l.pastNames = l.members.slice(0, 3).map((m) => m.name);
  l.members = l.members.slice(3); // three dropped
  for (let i = 0; i < 5; i++) {
    const m = makeRookie(l, cfg, r, now);
    assert.ok(!seen.has(m.id), `id ${m.id} reused`);
    assert.ok(!l.pastNames.includes(m.name), `name ${m.name} reused`);
    seen.add(m.id);
    l.members.push(m);
  }
});

test("open trades count in profit and the worst drop, not in the trade count", () => {
  const s = statsFromTrades([trade("2026-10-01T00:00:00Z", "2026-10-01T02:00:00Z", 40)], {
    bankrollUsd: 1000,
    minTrades: 1,
    openTrades: [trade("2026-10-02T00:00:00Z", "2026-10-05T00:00:00Z", -100, "still_open")],
  });
  assert.equal(s.trades, 1);
  assert.equal(s.winRate, 1);
  assert.equal(s.pnlUsd, -60);
  assert.equal(s.realizedPnlUsd, 40);
  assert.equal(s.openPnlUsd, -100);
  assert.equal(s.maxDrawdownUsd, 100);
  assert.equal(s.steadyScore, -16);
});

test("an old league switches to one-word names once, keeping ids, families and history", () => {
  const traits = { hustle: 0.5, creativity: 0.5, knowledge: 0.5 };
  const rule = rookieRule("dip_buyer", traits, rng(1));
  const l: LeagueFile = {
    version: 1,
    round: 2,
    members: [
      { id: "lg-ava-sterling-1", name: "Ava Sterling", style: "The Dip Hunter", family: "dip_buyer", traits, rule, generation: 1, bornAt: "2026-10-01T00:00:00Z", status: "active" },
      { id: "lg-milo-sterling-2", name: "Milo Sterling", style: "The Dip Hunter", family: "dip_buyer", traits, rule, generation: 2, parentId: "lg-ava-sterling-1", bornAt: "2026-10-02T00:00:00Z", status: "rookie" },
      { id: "lg-otis-vance-3", name: "Otis Vance", style: "The Original", family: "custom", traits, rule, generation: 1, parentId: "fav", bornAt: "2026-10-02T00:00:00Z", status: "rookie" },
    ],
    events: [{ at: "2026-10-02T00:00:00Z", kind: "cloned", memberId: "lg-milo-sterling-2", text: "Milo Sterling was cloned from Ava Sterling (generation 2)." }],
    pastNames: ["Finn Tanaka"],
  };
  const house = new Map([["fav", "Blaze"]]);
  const copy = JSON.parse(JSON.stringify(l)) as LeagueFile;
  migrateNames(l, house);
  migrateNames(copy, house);
  assert.deepEqual(l.members.map((m) => m.name), copy.members.map((m) => m.name), "same names every time");
  const [ava, milo, otis] = l.members;
  assert.match(ava.name, /^[A-Z][a-z]+$/);
  assert.notEqual(ava.name, "Blaze", "your rules' names stay theirs");
  assert.equal(milo.name, `${ava.name} II`);
  assert.equal(otis.name, "Blaze II", "a clone of your rule carries its name");
  assert.equal(ava.id, "lg-ava-sterling-1");
  assert.equal(l.events[0].text, `${milo.name} was cloned from ${ava.name} (generation 2).`);
  assert.equal(l.nameStyle, 2);
  const before = l.members.map((m) => m.name);
  migrateNames(l, new Map());
  assert.deepEqual(l.members.map((m) => m.name), before, "only once");
});

test("every league strategy aims to win at least 2x what it risks, with at least 48h per trade", () => {
  const r = rng(9);
  for (const f of FAMS) {
    for (let i = 0; i < 30; i++) {
      const traits = randomTraits(r);
      for (const body of [rookieRule(f, traits, r), mutate(rookieRule(f, traits, r), { ...traits, creativity: 0.95 }, traits, r)]) {
        const x = body.exit ?? {};
        if (x.stop_loss_pct != null) assert.ok(x.take_profit_pct! >= MIN_REWARD_RISK * x.stop_loss_pct - 1e-9, `${f}: +${x.take_profit_pct} vs −${x.stop_loss_pct}`);
        if (x.max_hold_hours != null) assert.ok(x.max_hold_hours >= MIN_HOLD_HOURS, `${f}: ${x.max_hold_hours}h`);
      }
    }
  }
});

test("existing strategies get the new floors, and switched-off types stop opening trades", () => {
  const old = member({ family: "momentum" });
  old.rule = { ...old.rule, exit: { take_profit_pct: 0.05, stop_loss_pct: 0.1, max_hold_hours: 2 } };
  const scalp = member({ id: "lg-s-2", name: "Zap", family: "scalper" });
  const l: LeagueFile = { version: 1, round: 1, members: [old, scalp], events: [], nameStyle: 2 };
  upgradeLeague(l, new Map());
  assert.equal(l.members[0].rule.exit?.take_profit_pct, 0.2);
  assert.equal(l.members[0].rule.exit?.max_hold_hours, MIN_HOLD_HOURS);
  assert.equal(l.ruleStyle, 3);
  assert.equal(l.members[0].rule.entry.max_buy_price, 0.95);
  assert.ok(!familyAllowed(scalp, undefined) && familyAllowed({ family: "custom" }, undefined));
  const rules = leagueRules(l, undefined);
  assert.equal(rules.find((x) => x.id === "lg-s-2")?.enabled, false, "still listed, so its open trades get their exits");
  assert.equal(rules.find((x) => x.id === old.id)?.enabled, true);
});

test("the diagnosis calls out targets that can't beat costs or are smaller than the stop", () => {
  const losing = Array.from({ length: 6 }, (_, i) => trade(`2026-10-0${i + 1}T00:00:00Z`, `2026-10-0${i + 1}T01:00:00Z`, -2, "stop_loss", 2.5));
  const s = statsFromTrades(losing, { bankrollUsd: 1000, minTrades: 5 });
  const rule = { exit: { take_profit_pct: 0.05, stop_loss_pct: 0.1 }, risk: { bankroll_usd: 1000, position_size_fraction: 0.05, max_position_usd: 50 } } as unknown as Parameters<typeof diagnose>[1]["rule"];
  const d = diagnose(s, { minTrades: 5, rule });
  assert.ok(d.findings.some((f) => /profit target \(\+5%\) is tiny next to its costs: fees alone take about 5\.0%/.test(f)), d.findings.join(" | "));
  assert.ok(d.findings.some((f) => /aims to win \+5% but risks −10%, so it must be right about 67%/.test(f)));
});
