import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LeagueSchema, RuleSchema, type LeagueConfig, type Rule } from "../rules/schema.js";
import type { StrategyStats } from "./metrics.js";
import type { Diagnosis } from "./diagnose.js";
import { leagueGuards, withRewardRisk, type FamilyId, type RuleBody } from "./genome.js";
import { cloneName, hashSeed, housePersonas, legacyHouseName, NAMES, rookieName, type Traits } from "./personas.js";

/** A strategy the league made (or one of your rules, seen as a "house" player). */
export interface Member {
  /** Rule id in the ledger: `lg-…`. */
  id: string;
  name: string;
  /** e.g. "The Dip Hunter". */
  style: string;
  family: FamilyId;
  traits: Traits;
  rule: RuleBody;
  generation: number;
  /** Who it was cloned from (a member id or one of your rule ids). */
  parentId?: string;
  bornAt: string;
  status: "rookie" | "active" | "champion" | "retired";
  retiredAt?: string;
  diagnosis?: Diagnosis;
  /** Paper trades from before this (an older version of its rules) don't count toward its score. */
  rulesSince?: string;
  /** Latest backtest: the whole window, the part it's ranked on, and the held-out last part. */
  backtest?: { all: StrategyStats; train?: StrategyStats; test: StrategyStats; at: string };
}

export interface LeagueEvent {
  at: string;
  kind: "born" | "cloned" | "retired" | "champion" | "round";
  memberId?: string;
  text: string;
}

export interface BacktestRun {
  at: string;
  from: string;
  to: string;
  testFrom: string;
  stepMinutes: number;
  markets: Record<string, number>;
  steps: number;
  seconds: number;
  /** Your own paper rules' backtest results (they aren't league members). */
  house: Record<string, { all: StrategyStats; train?: StrategyStats; test: StrategyStats; diagnosis?: Diagnosis }>;
  note?: string;
}

export interface LeagueFile {
  version: 1;
  round: number;
  members: Member[];
  events: LeagueEvent[];
  lastRun?: BacktestRun;
  nextRoundAt?: string;
  /** Member id counter (only goes up). */
  seq?: number;
  /** Names of members dropped from the file recently, so they aren't reused right away. */
  pastNames?: string[];
  /** 2 = one-word names ("Blaze", "Blaze II"). Older files used first + last names. */
  nameStyle?: number;
  /**
   * Rules follow the league guard rails: 2 = targets/time limits, 3 = + max buy price,
   * 4 = game winners before the game only, favorites hold to the result (old backtests no longer apply).
   */
  ruleStyle?: number;
}

/** The guard rails the current code applies; a file below this needs a fresh backtest round. */
export const LEAGUE_RULE_STYLE = 4;

/** Your own paper rules seen as league players (alert-only rules, arbitrage and copy trading aren't). */
export function houseContestantRules(file: { rules: Rule[] }): Rule[] {
  return file.rules.filter((r) => r.enabled && r.action === "paper");
}

/** League names for your own rules (stable per rule id). */
export function houseNames(file: { rules: Rule[] } | undefined): Map<string, string> {
  const personas = housePersonas((file ? houseContestantRules(file) : []).map((r) => r.id));
  return new Map([...personas].map(([id, p]) => [id, p.name]));
}

/**
 * One-time switch from "First Last" names to one-word names, in memory (a round saves it).
 * Deterministic, so every reader shows the same names before then. Ids don't change, so trades,
 * cool-downs and history stay attached. Clones become "<parent's name> II", "III"…
 */
/** Bring an older league file up to date, in memory (the next round saves it). */
export function upgradeLeague(l: LeagueFile, house: Map<string, string>, now = new Date()): void {
  migrateNames(l, house);
  if ((l.ruleStyle ?? 0) < 3) {
    l.ruleStyle = 3;
    for (const m of l.members) {
      try {
        if (m.rule?.exit || m.rule?.entry) m.rule = withRewardRisk(m.rule);
      } catch {
        // a broken member is skipped later, with a warning
      }
    }
  }
  if ((l.ruleStyle ?? 0) < 4) {
    l.ruleStyle = 4;
    for (const m of l.members) {
      try {
        if (m.rule) m.rule = leagueGuards(m.rule, m.family);
        // Its backtest was of the old rules: it has to pass again before trading, and only paper
        // trades under the new rules count from here.
        m.backtest = undefined;
        m.rulesSince = now.toISOString();
      } catch {
        // a broken member is skipped later, with a warning
      }
    }
  }
}

/**
 * May this member paper-trade? Only after its latest backtest made money overall AND in the
 * held-out last part, over enough trades. Rookies and clones wait for their first backtest.
 */
export function gateCheck(m: Pick<Member, "backtest" | "family">, cfg: LeagueConfig | undefined): { ok: boolean; why: string } {
  const c = cfg ?? LeagueSchema.parse({});
  if (!c.require_backtest) return { ok: true, why: "backtest gate is off" };
  const b = m.backtest;
  if (!b) return { ok: false, why: "waiting for its first backtest" };
  const trades = b.all.trades + (b.all.open ?? 0);
  if (trades < c.gate_min_trades) return { ok: false, why: `only ${trades} backtest trade(s) (needs ${c.gate_min_trades})` };
  if (b.all.pnlUsd <= 0) return { ok: false, why: `lost ${money(b.all.pnlUsd)} in its backtest` };
  const needTest = Math.max(2, Math.ceil(c.min_trades / 3));
  const tt = b.test.trades + (b.test.open ?? 0);
  if (tt < needTest) return { ok: false, why: `only ${tt} trade(s) in the held-out part (needs ${needTest})` };
  if (b.test.pnlUsd < 0) return { ok: false, why: `lost ${money(b.test.pnlUsd)} in the held-out part` };
  return { ok: true, why: `made ${money(b.all.pnlUsd)} over ${trades} backtest trades, ${money(b.test.pnlUsd)} held out` };
}

const money = (x: number) => `${x < 0 ? "−" : ""}$${Math.abs(x).toFixed(2)}`;

export function migrateNames(l: LeagueFile, house: Map<string, string>): void {
  if (l.nameStyle === 2) return;
  l.nameStyle = 2;
  if (!l.members.length) return;
  const taken = new Set<string>(house.values());
  const renamed = new Map<string, string>(); // id → new name
  const order = [...l.members].sort(
    (a, b) => String(a.bornAt ?? "").localeCompare(String(b.bornAt ?? "")) || (a.generation ?? 0) - (b.generation ?? 0) || String(a.id).localeCompare(String(b.id)),
  );
  for (const m of order) {
    const parent = m.parentId ? renamed.get(m.parentId) ?? house.get(m.parentId) : undefined;
    let name: string;
    if (parent) name = cloneName(parent, taken);
    else {
      let i = hashSeed(`name:${String(m.id)}`) % NAMES.length;
      for (let k = 0; k < NAMES.length && taken.has(NAMES[i]); k++) i = (i + 1) % NAMES.length;
      name = taken.has(NAMES[i]) ? rookieName(() => 0.5, taken) : NAMES[i];
    }
    taken.add(name);
    renamed.set(m.id, name);
  }
  const swaps = l.members
    .map((m) => [typeof m.name === "string" ? m.name : "", renamed.get(m.id)!] as const)
    .concat([...house].map(([id, name]) => [legacyHouseName(id), name] as const))
    .filter(([from]) => from.length > 0)
    .sort((a, b) => b[0].length - a[0].length);
  for (const m of l.members) m.name = renamed.get(m.id)!;
  for (const e of l.events) if (typeof e?.text === "string") for (const [from, to] of swaps) e.text = e.text.split(from).join(to);
  l.pastNames = [];
}

/** data/paper-ledger.json → data/paper-ledger.league.json */
export function leaguePathFor(ledgerPath: string): string {
  const ext = path.extname(ledgerPath);
  return ext ? `${ledgerPath.slice(0, -ext.length)}.league${ext}` : `${ledgerPath}.league.json`;
}

/**
 * The league file, or an empty league when there is none yet. A file that exists but can't be read
 * throws, so a round never overwrites it (move it aside to start over).
 */
export async function loadLeague(file: string): Promise<LeagueFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, round: 0, members: [], events: [] };
    throw err;
  }
  let d: LeagueFile;
  try {
    d = JSON.parse(raw) as LeagueFile;
  } catch (err) {
    throw new Error(`League file ${file} is not valid JSON (${(err as Error).message}). Move it aside to start a new league.`);
  }
  if (d?.version !== 1 || !Array.isArray(d.members)) throw new Error(`League file ${file} has an unknown format. Move it aside to start a new league.`);
  return { ...d, events: Array.isArray(d.events) ? d.events : [] };
}

export async function saveLeague(file: string, l: LeagueFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(l, null, 1));
  await rename(tmp, file);
}

export const MEMBER_PREFIX = "lg-";

/** A member as a normal paper Rule. Retired members keep a rule so their open trades are still managed. */
export function memberRule(m: Member): Rule {
  return RuleSchema.parse({ ...m.rule, id: m.id, name: `${m.name} — ${m.style}`, enabled: m.status !== "retired", action: "paper" });
}

/** The `league:` block, or its defaults when the rules file has none (the league is on by default). */
export function leagueConfig(file: { league?: LeagueConfig }): LeagueConfig {
  return file.league ?? LeagueSchema.parse({});
}

/** Rules the paper session should run for the league: active members (and retired ones, disabled, for exits). */
/** Is this member's type of strategy switched on (`families`)? Clones of your rules always are. */
export function familyAllowed(m: Pick<Member, "family">, cfg: LeagueConfig | undefined): boolean {
  if (m.family === "custom") return true;
  return (cfg ?? LeagueSchema.parse({})).families.includes(m.family);
}

export function leagueRules(l: LeagueFile, cfg: LeagueConfig | undefined, onBad?: (m: Member, err: Error) => void): Rule[] {
  const out: Rule[] = [];
  for (const m of l.members) {
    try {
      const r = memberRule(m);
      // Switched off (the whole league, or this type), or not proven in a backtest: no new trades,
      // open ones still get their exits.
      const off = (cfg && !cfg.enabled) || !familyAllowed(m, cfg) || !gateCheck(m, cfg).ok;
      out.push(off ? { ...r, enabled: false } : r);
    } catch (err) {
      // One broken member mustn't stop paper trading for everything else.
      onBad?.(m, err as Error);
    }
  }
  return out;
}

export function activeMembers(l: LeagueFile): Member[] {
  return l.members.filter((m) => m.status !== "retired");
}

export function memberId(name: string, n: number): string {
  return `${MEMBER_PREFIX}${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${n.toString(36)}`;
}

/** Paper results start to count once a strategy has this many finished paper trades. */
export const PAPER_TRADES_TO_COUNT = 10;

/** Pick the score: the backtest, blended 50/50 with paper once there are enough paper trades. */
/**
 * Pick the score: the backtest's steady score on the part before the held-out test (so the test
 * stays a real check), blended 50/50 with paper once there are enough paper trades.
 * Ranked once the whole backtest (or paper) has `min_trades` finished trades.
 */
export function scoreOf(bt: { all: StrategyStats; train?: StrategyStats } | undefined, paper: StrategyStats): { score: number; ranked: boolean } {
  const paperCounts = paper.trades >= PAPER_TRADES_TO_COUNT;
  const btScore = bt ? (bt.train ?? bt.all).steadyScore : 0;
  if (bt?.all.ranked && paperCounts) return { score: Math.round(((btScore + paper.steadyScore) / 2) * 100) / 100, ranked: true };
  if (paperCounts) return { score: paper.steadyScore, ranked: true };
  if (bt) return { score: btScore, ranked: bt.all.ranked };
  return { score: paper.steadyScore, ranked: paper.ranked };
}

/** Where backtest files live: next to the ledger, in `backtest/`. */
export function backtestDirs(ledgerPath: string): { cacheDir: string; workDir: string } {
  const base = path.join(path.dirname(ledgerPath), "backtest");
  return { cacheDir: path.join(base, "cache"), workDir: path.join(base, "last-run") };
}
