import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { RuleSchema, type Rule } from "../rules/schema.js";
import { LabQuery, toParams, type LabQueryIn, type LabRunResponse } from "./api.js";
import { ruleBlocker, ruleFor, type LabRuleData } from "./engine.js";

/**
 * Lab strategies: tests from the backtest lab that were added to paper trading with the
 * dashboard's button. They live in their own file next to the ledger (`*.lab.json`), written only
 * by the dashboard and read by every paper cycle, which trades them like any other paper rule.
 *
 * Paper only, by construction: the rule is rebuilt here from the lab's settings (never taken from
 * the browser), and whatever the file says, a strategy is loaded as `action: paper`.
 */

export const LAB_RULE_PREFIX = "lab-";
/** How many lab strategies can trade at once (each one is a bankroll of its own). */
export const MAX_LAB_STRATEGIES = 12;

/** The settings that decide what a strategy buys and how much, as the lab page sends them. */
const KEPT = ["pick", "min", "max", "entry", "from", "move", "spread", "leagues", "exec", "exit", "exitH", "stake", "size", "pct", "bank"] as const;
export type LabSettings = Pick<LabQueryIn, (typeof KEPT)[number]>;

/** What the lab's test said when the strategy was added: a record of the evidence, not a promise. */
export interface LabTestSnapshot {
  at: string;
  bets: number;
  pnl: number;
  /** Return per $1 staked and its standard error. */
  ret: number;
  retSe: number;
  verdict: string;
  /** First and last game in the test (epoch ms). */
  from?: number;
  to?: number;
}

/** What a run said, to keep with a strategy added from it. */
export function snapshotOf(run: LabRunResponse, now: Date): LabTestSnapshot {
  return {
    at: now.toISOString(),
    bets: run.stats.bets,
    pnl: Math.round(run.stats.pnl * 100) / 100,
    ret: run.stats.ret,
    retSe: run.stats.retSe,
    verdict: run.verdict,
    from: run.equity[0]?.[0],
    to: run.equity.at(-1)?.[0],
  };
}

export interface LabStrategy {
  id: string;
  name: string;
  addedAt: string;
  updatedAt?: string;
  /** Removed from paper trading: no new bets. Kept so its name and open bets still make sense. */
  removedAt?: string;
  settings: LabSettings;
  test?: LabTestSnapshot;
  rule: LabRuleData;
  /** Where the rule can't do exactly what the test did. */
  notes: string[];
}

export interface LabStrategyFile {
  version: 1;
  strategies: LabStrategy[];
}

export function strategiesPathFor(ledgerPath: string): string {
  return ledgerPath.replace(/\.json$/i, "") + ".lab.json";
}

export function emptyStrategies(): LabStrategyFile {
  return { version: 1, strategies: [] };
}

/** A missing file is an empty list. A file that can't be read is an error (never silently dropped strategies). */
export async function loadStrategies(file: string): Promise<LabStrategyFile> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyStrategies();
    throw new Error(`can't read ${path.basename(file)}: ${(err as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error(`${path.basename(file)} isn't valid JSON`);
  }
  const f = raw as Partial<LabStrategyFile> | null;
  if (!f || f.version !== 1 || !Array.isArray(f.strategies)) throw new Error(`${path.basename(file)} isn't a lab strategies file`);
  return { version: 1, strategies: f.strategies.filter((s) => s && typeof s === "object" && typeof s.id === "string") };
}

export async function saveStrategies(file: string, data: LabStrategyFile): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, file);
}

/**
 * The strategies as rules for a paper cycle. Removed ones come back disabled (their open bets
 * still settle under their own name). A strategy whose id is already used by the rules file, or
 * whose rule doesn't load, is skipped and reported.
 */
export function labRules(data: LabStrategyFile, taken: ReadonlySet<string>, onBad?: (s: LabStrategy, why: string) => void): Rule[] {
  const out: Rule[] = [];
  const seen = new Set<string>();
  for (const s of data.strategies) {
    if (!s.id.startsWith(LAB_RULE_PREFIX)) {
      onBad?.(s, `its id must start with "${LAB_RULE_PREFIX}"`);
      continue;
    }
    if (taken.has(s.id) || seen.has(s.id)) {
      onBad?.(s, "a rule with the same id already exists");
      continue;
    }
    const parsed = RuleSchema.safeParse({ ...s.rule, id: s.id, name: typeof s.name === "string" && s.name ? s.name : s.id, action: "paper", enabled: !s.removedAt });
    if (!parsed.success) {
      onBad?.(s, `${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`.slice(0, 160));
      continue;
    }
    seen.add(s.id);
    out.push(parsed.data);
  }
  return out;
}

export function activeStrategies(data: LabStrategyFile): LabStrategy[] {
  return data.strategies.filter((s) => !s.removedAt);
}

/** A request the user can fix (shown as is on the page). */
export class LabStrategyError extends Error {}

const sameMoney = (a: LabRuleData["risk"], b: LabRuleData["risk"] | undefined) =>
  !!b && a.bankroll_usd === b.bankroll_usd && a.position_size_fraction === b.position_size_fraction && a.max_position_usd === b.max_position_usd;

export type AddOutcome = "added" | "updated" | "restored" | "unchanged";

/**
 * Add a lab test to paper trading (or bring it up to date). The same picks with a different bet
 * size update the one strategy: two strategies would buy the same games twice.
 */
export function addStrategy(
  data: LabStrategyFile,
  query: LabQueryIn,
  opts: { now: Date; test?: LabTestSnapshot; taken?: ReadonlySet<string> },
): { outcome: AddOutcome; strategy: LabStrategy } {
  const p = toParams(query);
  const blocked = ruleBlocker(p);
  if (blocked) throw new LabStrategyError(blocked);
  const made = ruleFor(p)!;
  if (!RuleSchema.safeParse(made.rule).success) throw new LabStrategyError("These settings don't make a rule the bot can load.");
  if (opts.taken?.has(made.rule.id)) throw new LabStrategyError("A rule with this id is already in your rules file, so it's trading already.");
  const settings = Object.fromEntries(KEPT.map((k) => [k, query[k]])) as LabSettings;
  const at = opts.now.toISOString();
  const existing = data.strategies.find((s) => s.id === made.rule.id);
  if (!existing) {
    if (activeStrategies(data).length >= MAX_LAB_STRATEGIES) throw new LabStrategyError(`${MAX_LAB_STRATEGIES} lab strategies are trading already. Remove one first.`);
    const strategy: LabStrategy = { id: made.rule.id, name: made.rule.name, addedAt: at, settings, test: opts.test, rule: made.rule, notes: made.notes };
    data.strategies.push(strategy);
    return { outcome: "added", strategy };
  }
  const wasRemoved = !!existing.removedAt;
  if (wasRemoved && activeStrategies(data).length >= MAX_LAB_STRATEGIES) throw new LabStrategyError(`${MAX_LAB_STRATEGIES} lab strategies are trading already. Remove one first.`);
  const unchanged = !wasRemoved && sameMoney(made.rule.risk, existing.rule?.risk);
  if (unchanged) return { outcome: "unchanged", strategy: existing };
  Object.assign(existing, { name: made.rule.name, settings, rule: made.rule, notes: made.notes, updatedAt: at, removedAt: undefined });
  if (opts.test) existing.test = opts.test;
  if (wasRemoved) existing.addedAt = at;
  return { outcome: wasRemoved ? "restored" : "updated", strategy: existing };
}

/** Stop a strategy's new bets. Its open bets stay until they settle. False when there's nothing to remove. */
export function removeStrategy(data: LabStrategyFile, id: string, now: Date): boolean {
  const s = data.strategies.find((x) => x.id === id && !x.removedAt);
  if (!s) return false;
  s.removedAt = now.toISOString();
  return true;
}

/** Undo a remove: the strategy trades again exactly as it was. */
export function restoreStrategy(data: LabStrategyFile, id: string): LabStrategy {
  const s = data.strategies.find((x) => x.id === id);
  if (!s) throw new LabStrategyError("That strategy isn't in the list any more.");
  if (!s.removedAt) return s;
  if (activeStrategies(data).length >= MAX_LAB_STRATEGIES) throw new LabStrategyError(`${MAX_LAB_STRATEGIES} lab strategies are trading already. Remove one first.`);
  s.removedAt = undefined;
  return s;
}

/** Settings from a request body, in the same shape (and with the same limits) as a lab run. */
export function parseSettings(raw: unknown): LabQueryIn {
  const src = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const flat = Object.fromEntries(Object.entries(src).map(([k, v]) => [k, Array.isArray(v) ? v.join(",") : v]));
  const parsed = LabQuery.safeParse(flat);
  if (!parsed.success) throw new LabStrategyError(`Bad setting: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
  return parsed.data;
}
