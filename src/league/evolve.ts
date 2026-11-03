import { runBacktest, testTradesNeeded, type BacktestResult } from "../backtest/run.js";
import type { HistorySet } from "../backtest/history.js";
import { loadLedger } from "../ledger/paper.js";
import { loadRulesFile } from "../rules/loader.js";
import type { LeagueConfig, Rule } from "../rules/schema.js";
import { diagnose, type Diagnosis } from "./diagnose.js";
import { FAMILIES, mutate, rookieRule, toBody, type FamilyId, type RuleBody } from "./genome.js";
import {
  activeMembers,
  backtestDirs,
  houseContestantRules,
  familyAllowed,
  houseNames,
  upgradeLeague,
  leagueConfig,
  PAPER_TRADES_TO_COUNT,
  scoreOf,
  leaguePathFor,
  loadLeague,
  memberId,
  memberRule,
  saveLeague,
  type LeagueEvent,
  type LeagueFile,
  type Member,
} from "./league.js";
import { openTradesByRule, statsFromTrades, tradesByRule, type StrategyStats } from "./metrics.js";
import { cloneName, hashSeed, housePersonas, inheritTraits, randomTraits, rng, rookieName, type Traits } from "./personas.js";

/**
 * One league round: fill the roster with rookies, backtest everyone (plus your own rules), rank,
 * clone the best, diagnose and retire the worst. Paper trading picks the new roster up on its next
 * cycle. Paper only; nothing here can place an order.
 */

export interface Contestant {
  id: string;
  name: string;
  style: string;
  house: boolean;
  member?: Member;
  traits: Traits;
  rule: RuleBody;
  backtest?: { all: StrategyStats; train: StrategyStats; test: StrategyStats };
  paper: StrategyStats;
  /** The score it's ranked by this round (steady score). */
  score: number;
  ranked: boolean;
  /** Ranked, scored above zero, and didn't lose money in the held-out test period. */
  eligible: boolean;
  diagnosis: Diagnosis;
}

export interface RoundSummary {
  round: number;
  born: Member[];
  cloned: Member[];
  retired: Member[];
  champion?: Contestant;
  standings: Contestant[];
  backtest?: BacktestResult;
}

export interface RoundOptions {
  rulesPath: string;
  ledgerPath: string;
  now?: Date;
  seed?: number;
  /** Skip the backtest (rank on paper results only). */
  noBacktest?: boolean;
  /** Test hook: use this price history instead of downloading it. */
  history?: HistorySet;
  /** Override the backtest window (days). */
  days?: number;
  /** Override markets per platform. */
  markets?: number;
  /** The paper ledger holds demo data (--demo). */
  demo?: boolean;
  log?: (m: string) => void;
}

function event(l: LeagueFile, at: Date, kind: LeagueEvent["kind"], text: string, memberId?: string) {
  l.events.push({ at: at.toISOString(), kind, memberId, text });
}

function nextFamily(cfg: LeagueConfig, members: Member[]): Exclude<FamilyId, "custom"> {
  const count = (f: string) => members.filter((m) => m.family === f).length;
  return [...cfg.families].sort((a, b) => count(a) - count(b))[0];
}

/** Names in use now, used recently, or given to your own rules. */
function takenNames(l: LeagueFile, reserved?: Set<string>): Set<string> {
  return new Set([...l.members.map((m) => m.name), ...(l.pastNames ?? []), ...(reserved ?? [])]);
}

/** Ids come from a counter that only goes up, so a new strategy never inherits an old one's trades. */
function nextId(l: LeagueFile, name: string): string {
  l.seq = Math.max(l.seq ?? 0, l.members.length) + 1;
  return memberId(name, l.seq);
}

export function makeRookie(l: LeagueFile, cfg: LeagueConfig, r: () => number, now: Date, reserved?: Set<string>): Member {
  const family = nextFamily(cfg, activeMembers(l));
  const traits = randomTraits(r);
  const name = rookieName(r, takenNames(l, reserved));
  return {
    id: nextId(l, name),
    name,
    style: FAMILIES[family].style,
    family,
    traits,
    rule: rookieRule(family, traits, r),
    generation: 1,
    bornAt: now.toISOString(),
    status: "rookie",
  };
}

export function makeClone(l: LeagueFile, parent: Contestant, r: () => number, now: Date, reserved?: Set<string>): Member {
  const traits = inheritTraits(parent.traits, r);
  const name = cloneName(parent.name, takenNames(l, reserved));
  const family: FamilyId = parent.member?.family ?? "custom";
  return {
    id: nextId(l, name),
    name,
    style: FAMILIES[family].style,
    family,
    traits,
    rule: mutate(parent.rule, parent.traits, traits, r),
    generation: (parent.member?.generation ?? 0) + 1,
    parentId: parent.id,
    bornAt: now.toISOString(),
    status: "rookie",
  };
}

export { houseContestantRules };

export async function runRound(o: RoundOptions): Promise<{ league: LeagueFile; summary: RoundSummary }> {
  const now = o.now ?? new Date();
  const r = rng(o.seed ?? hashSeed(now.toISOString()));
  const file = await loadRulesFile(o.rulesPath);
  const cfg = leagueConfig(file);
  const leaguePath = leaguePathFor(o.ledgerPath);
  const l = await loadLeague(leaguePath);
  const houseNameMap = houseNames(file);
  const reserved = new Set(houseNameMap.values());
  upgradeLeague(l, houseNameMap);
  const round = l.round + 1;
  const born: Member[] = [];
  const cloned: Member[] = [];
  const retired: Member[] = [];

  // 0. Types of strategy that are switched off (league `families`) retire now; open trades keep their exits.
  for (const m of activeMembers(l)) {
    if (familyAllowed(m, cfg)) continue;
    m.status = "retired";
    m.retiredAt = now.toISOString();
    retired.push(m);
    event(l, now, "retired", `${m.name} retired: ${m.style} is switched off (in backtests that type lost money in every version tried).`, m.id);
  }

  // 1. Fill the roster.
  while (activeMembers(l).length < cfg.roster_size) {
    const m = makeRookie(l, cfg, r, now, reserved);
    l.members.push(m);
    born.push(m);
    event(l, now, "born", `${m.name} joined as ${m.style} (${FAMILIES[m.family].idea}).`, m.id);
  }

  // 2. Backtest everyone still playing, and your own rules.
  const house = houseContestantRules(file);
  const personas = housePersonas(house.map((h) => h.id));
  const players = activeMembers(l);
  let bt: BacktestResult | undefined;
  if (!o.noBacktest) {
    const dirs = backtestDirs(o.ledgerPath);
    o.log?.(`Backtesting ${players.length} league strategies and ${house.length} of your rules over ${o.days ?? cfg.backtest_days} days…`);
    bt = await runBacktest({
      rules: [...players.map(memberRule), ...house],
      ...dirs,
      days: o.days ?? cfg.backtest_days,
      stepMinutes: cfg.step_minutes,
      testShare: cfg.test_share,
      perPlatform: o.markets ?? cfg.markets_per_platform,
      minTrades: cfg.min_trades,
      now,
      history: o.history,
      log: o.log,
    });
  }

  // 3. Paper results so far (the real ledger, read only).
  let ledger: Awaited<ReturnType<typeof loadLedger>> | undefined;
  try {
    ledger = await loadLedger(o.ledgerPath, { demo: !!o.demo });
  } catch (err) {
    o.log?.(`Couldn't read the paper ledger (${(err as Error).message}); ranking on backtests only.`);
    ledger = undefined;
  }
  const paperTrades = ledger ? tradesByRule(ledger) : new Map();
  const paperOpen = ledger ? openTradesByRule(ledger, now) : new Map();
  const paperStats = (id: string, bankroll: number) =>
    statsFromTrades(paperTrades.get(id) ?? [], { bankrollUsd: bankroll, minTrades: cfg.min_trades, openTrades: paperOpen.get(id) });

  const contestants: Contestant[] = [];
  const add = (c: Omit<Contestant, "score" | "ranked" | "eligible" | "diagnosis">) => {
    const res = bt?.results.get(c.id);
    const backtest = res ? { all: res.all, train: res.train, test: res.test } : undefined;
    const { score, ranked } = scoreOf(backtest, c.paper);
    // A winner must also hold up on the held-out last part: enough trades there, and no loss.
    const heldUp = !backtest || (backtest.test.trades + backtest.test.open >= testTradesNeeded(cfg.min_trades) && backtest.test.pnlUsd >= 0);
    const eligible = ranked && score > 0 && heldUp;
    const basis = backtest && c.paper.trades < PAPER_TRADES_TO_COUNT ? backtest.all : c.paper;
    const diagnosis = diagnose(basis, { minTrades: cfg.min_trades, blocks: res?.blocks, test: backtest?.test, now, rule: c.rule });
    contestants.push({ ...c, backtest, score, ranked, eligible, diagnosis });
  };
  for (const m of players) {
    add({ id: m.id, name: m.name, style: m.style, house: false, member: m, traits: m.traits, rule: m.rule, paper: paperStats(m.id, m.rule.risk.bankroll_usd) });
  }
  for (const h of house) {
    const p = personas.get(h.id)!;
    add({ id: h.id, name: p.name, style: `${FAMILIES.custom.style} (${h.name})`, house: true, traits: p.traits, rule: toBody({ ...h, action: "paper", enabled: true }), paper: paperStats(h.id, h.risk.bankroll_usd) });
  }

  // 4. Rank: ranked players by score, then the rest by score.
  const standings = [...contestants].sort((a, b) => Number(b.ranked) - Number(a.ranked) || b.score - a.score);
  for (const c of standings) {
    if (!c.member) continue;
    c.member.diagnosis = c.diagnosis;
    if (c.backtest) c.member.backtest = { ...c.backtest, at: now.toISOString() };
    else if (bt) c.member.backtest = undefined;
    if (c.member.status === "rookie" && c.ranked) c.member.status = "active";
  }
  const winners = standings.filter((c) => c.eligible && (!c.house || cfg.clone_house_rules)).slice(0, cfg.winners);

  // Champion: the best eligible player this round.
  const champ = standings.find((c) => c.eligible);
  for (const m of activeMembers(l)) if (m.status === "champion" && m.id !== champ?.id) m.status = "active";
  if (champ?.member && champ.member.status !== "champion") {
    champ.member.status = "champion";
    event(l, now, "champion", `${champ.name} is the new champion (steady score ${champ.score.toFixed(1)}).`, champ.id);
  } else if (champ?.house) {
    event(l, now, "champion", `Your rule "${champ.style}" leads the league (steady score ${champ.score.toFixed(1)}).`, champ.id);
  }

  // 5. Retire the worst: losing money once ranked, or never trading at all.
  const retire = (c: Contestant, why: string) => {
    const m = c.member!;
    m.status = "retired";
    m.retiredAt = now.toISOString();
    retired.push(m);
    event(l, now, "retired", `${m.name} retired: ${why} ${c.diagnosis.headline}`, m.id);
  };
  const winnerIds = new Set(winners.map((w) => w.id));
  const neverTraded = (c: Contestant) => (c.backtest?.all.trades ?? 0) === 0 && (c.backtest?.all.open ?? 0) === 0 && c.paper.trades === 0 && c.paper.open === 0;
  const losers = standings
    .filter((c) => c.member && !winnerIds.has(c.id) && ((c.ranked && c.score < 0) || (!o.noBacktest && neverTraded(c))))
    .sort((a, b) => Number(neverTraded(b)) - Number(neverTraded(a)) || a.score - b.score);
  for (const c of losers.slice(0, cfg.retire)) retire(c, neverTraded(c) ? "it never found a trade." : `steady score ${c.score.toFixed(1)}.`);

  // Room for clones: if the roster is still full, the weakest ranked non-winners make way.
  const wanted = winners.length * cfg.clones_per_winner;
  let room = cfg.roster_size - activeMembers(l).length;
  if (room < wanted) {
    const spare = standings
      .filter((c) => c.member && c.member.status !== "retired" && c.ranked && !winnerIds.has(c.id) && c.id !== champ?.id)
      .sort((a, b) => a.score - b.score)
      .slice(0, Math.min(cfg.retire - retired.length, wanted - room));
    for (const c of spare) retire(c, `made room for a stronger strategy (steady score ${c.score.toFixed(1)}).`);
    room = cfg.roster_size - activeMembers(l).length;
  }

  // 6. Clone the winners (best first).
  for (const w of winners) {
    for (let k = 0; k < cfg.clones_per_winner && room > 0; k++, room--) {
      const child = makeClone(l, w, r, now, reserved);
      l.members.push(child);
      cloned.push(child);
      event(l, now, "cloned", `${child.name} was cloned from ${w.house ? `your rule "${w.style}"` : w.name} (generation ${child.generation}).`, child.id);
    }
  }

  // 7. Top the roster back up with rookies (they're backtested next round).
  while (activeMembers(l).length < cfg.roster_size) {
    const m = makeRookie(l, cfg, r, now, reserved);
    l.members.push(m);
    born.push(m);
    event(l, now, "born", `${m.name} joined as ${m.style} (${FAMILIES[m.family].idea}).`, m.id);
  }

  const top = standings.slice(0, 3).map((c, i) => `${i + 1}. ${c.name} ${c.score.toFixed(1)}`).join(", ");
  event(l, now, "round", `Round ${round}: ${top || "no results yet"}. ${cloned.length} cloned, ${retired.length} retired, ${born.length} new.`);

  l.round = round;
  l.nextRoundAt = new Date(now.getTime() + cfg.evolve_every_hours * 3600_000).toISOString();
  if (bt) {
    l.lastRun = {
      at: now.toISOString(),
      from: bt.from,
      to: bt.to,
      testFrom: bt.testFrom,
      stepMinutes: bt.stepMinutes,
      markets: bt.markets,
      steps: bt.steps,
      seconds: bt.seconds,
      house: Object.fromEntries(
        contestants.filter((c) => c.house && c.backtest).map((c) => [c.id, { all: c.backtest!.all, train: c.backtest!.train, test: c.backtest!.test, diagnosis: c.diagnosis }]),
      ),
      note: bt.notes.join(" ") || undefined,
    };
  }
  l.events = l.events.slice(-300);
  // Keep the newest retirees for the history page. Only drop ones we know have nothing open
  // (their rule must stay in the file while a position is open, so its exits keep running).
  if (ledger) {
    const retiredOld = l.members.filter((m) => m.status === "retired").sort((a, b) => (b.retiredAt ?? "").localeCompare(a.retiredAt ?? "")).slice(30);
    const drop = new Set(retiredOld.filter((m) => !ledger!.positions.some((p) => p.ruleId === m.id && p.status === "open")).map((m) => m.id));
    l.pastNames = [...(l.pastNames ?? []), ...l.members.filter((m) => drop.has(m.id)).map((m) => m.name)].slice(-40);
    l.members = l.members.filter((m) => !drop.has(m.id));
  }
  await saveLeague(leaguePath, l);
  return { league: l, summary: { round, born, cloned, retired, champion: champ, standings, backtest: bt } };
}
