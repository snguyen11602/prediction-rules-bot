import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { LeagueSchema, RuleSchema, type LeagueConfig, type Rule } from "../rules/schema.js";
import type { StrategyStats } from "./metrics.js";
import type { Diagnosis } from "./diagnose.js";
import type { FamilyId, RuleBody } from "./genome.js";
import type { Traits } from "./personas.js";

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
  /** Latest backtest: the whole window and the held-out last part. */
  backtest?: { all: StrategyStats; test: StrategyStats; at: string };
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
  house: Record<string, { all: StrategyStats; test: StrategyStats; diagnosis?: Diagnosis }>;
  note?: string;
}

export interface LeagueFile {
  version: 1;
  round: number;
  members: Member[];
  events: LeagueEvent[];
  lastRun?: BacktestRun;
  nextRoundAt?: string;
}

/** data/paper-ledger.json → data/paper-ledger.league.json */
export function leaguePathFor(ledgerPath: string): string {
  const ext = path.extname(ledgerPath);
  return ext ? `${ledgerPath.slice(0, -ext.length)}.league${ext}` : `${ledgerPath}.league.json`;
}

export async function loadLeague(file: string): Promise<LeagueFile> {
  try {
    const d = JSON.parse(await readFile(file, "utf8")) as LeagueFile;
    if (d?.version === 1 && Array.isArray(d.members)) return { ...d, events: d.events ?? [] };
  } catch {
    // none yet
  }
  return { version: 1, round: 0, members: [], events: [] };
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
export function leagueRules(l: LeagueFile, cfg: LeagueConfig | undefined): Rule[] {
  if (cfg && !cfg.enabled) return l.members.map((m) => ({ ...memberRule(m), enabled: false }));
  return l.members.map(memberRule);
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
export function scoreOf(bt: { all: StrategyStats } | undefined, paper: StrategyStats): { score: number; ranked: boolean } {
  const paperCounts = paper.trades >= PAPER_TRADES_TO_COUNT;
  if (bt?.all.ranked && paperCounts) return { score: Math.round(((bt.all.steadyScore + paper.steadyScore) / 2) * 100) / 100, ranked: true };
  if (paperCounts) return { score: paper.steadyScore, ranked: true };
  if (bt) return { score: bt.all.steadyScore, ranked: bt.all.ranked };
  return { score: paper.steadyScore, ranked: paper.ranked };
}

/** Where backtest files live: next to the ledger, in `backtest/`. */
export function backtestDirs(ledgerPath: string): { cacheDir: string; workDir: string } {
  const base = path.join(path.dirname(ledgerPath), "backtest");
  return { cacheDir: path.join(base, "cache"), workDir: path.join(base, "last-run") };
}
