import { mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { RiskState } from "../engine/risk.js";
import { dayKeyLA } from "../engine/clock.js";
import type { PaperExitReason, PaperFill, PlatformId, SignalSide } from "../types.js";

/**
 * Paper ledger (hypothetical only — nothing here talks to an exchange).
 *
 * v2 layout:
 *  - positions:  one row per paper position, open or closed, with marks and PnL
 *  - fills:      append-only journal of open/close fills (v1 rows still parse)
 *  - ruleState:  consecutive-loss streak + pause per rule, persisted across runs
 *  - lastPrices: last observed YES price per market, so move rules work across runs
 *
 * Exposure (for the bankroll gate) is open cost basis; entry fees show up in
 * unrealized PnL and, once closed, in realized PnL.
 *
 * PnL math (binary contracts, prices 0–1 for the held side):
 *   contracts  = costUsd / entryPrice
 *   proceeds   = contracts × exitPrice        (exitPrice = 1 or 0 at resolution)
 *   realized   = proceeds − costUsd − entryFeeUsd − exitFeeUsd
 *   unrealized = contracts × markPrice − costUsd − entryFeeUsd   (exit fee not included)
 */

export const DEFAULT_LEDGER = "data/paper-ledger.json";
export const DEFAULT_DEMO_LEDGER = "data/paper-ledger.demo.json";
const LOCK_STALE_MS = 15 * 60_000;
const LAST_PRICE_MAX_AGE_HOURS = 48;

export interface PaperPosition {
  id: string;
  ruleId: string;
  platform: PlatformId;
  marketId: string;
  title: string;
  url?: string;
  side: SignalSide;
  status: "open" | "closed";
  entryAt: string;
  /** Price paid for the held side (0–1), including slippage. */
  entryPrice: number;
  contracts: number;
  /** contracts × entryPrice, before fees. */
  costUsd: number;
  entryFeeUsd: number;
  lastMarkPrice?: number;
  lastMarkAt?: string;
  marketStatus?: "open" | "closed" | "resolved";
  unrealizedPnlUsd?: number;
  exitAt?: string;
  exitPrice?: number;
  exitFeeUsd?: number;
  exitReason?: PaperExitReason;
  exitDetail?: string;
  realizedPnlUsd?: number;
  /** Leg of an arbitrage group (see PaperLedger.arbGroups). Grouped legs are never exited on their own rules. */
  groupId?: string;
  hypothetical: true;
}

/** One arbitrage = several linked legs that only make sense together. */
export interface ArbGroupRecord {
  id: string;
  ruleId: string;
  /** Basket key (pair or event) — used for re-entry cool-downs. */
  key: string;
  kind: "cross_platform" | "no_basket" | "yes_basket";
  title: string;
  matchedBy: "confirmed" | "auto" | "platform";
  score?: number;
  status: "open" | "closed";
  openedAt: string;
  sets: number;
  payoutPerSet: number;
  costUsd: number;
  entryFeesUsd: number;
  /** Profit locked in at entry if every leg settles as expected. */
  expectedProfitUsd: number;
  edge: number;
  legIds: string[];
  closedAt?: string;
  closeReason?: "resolved" | "arb_unwind" | "manual" | "mixed";
  realizedPnlUsd?: number;
}

export interface RulePaperState {
  consecutiveLosses: number;
  pausedUntil?: string;
}

export interface PaperLedger {
  version: 2;
  createdAt: string;
  /** Built from --demo fixtures. Demo and real-data runs never share a ledger. */
  demo: boolean;
  positions: PaperPosition[];
  fills: PaperFill[];
  ruleState: Record<string, RulePaperState>;
  lastPrices: Record<string, { yesPrice: number; at: string }>;
  /** Set when this ledger was upgraded from v1; legacy fills stay in `fills` only. */
  migratedFromV1?: { at: string; legacyFills: number };
  /** Arbitrage groups by id (optional; added with the arbitrage strategy). */
  arbGroups?: Record<string, ArbGroupRecord>;
}

interface PaperLedgerV1 {
  version: 1;
  fills: PaperFill[];
}

export function defaultLedgerPath(demo: boolean): string {
  return path.resolve(demo ? DEFAULT_DEMO_LEDGER : DEFAULT_LEDGER);
}

export function emptyLedger(demo: boolean, now = new Date()): PaperLedger {
  return {
    version: 2,
    createdAt: now.toISOString(),
    demo,
    positions: [],
    fills: [],
    ruleState: {},
    lastPrices: {},
  };
}

/**
 * v1 ledgers recorded opening fills only, mixed --demo and real-data runs in one
 * file, and re-filled the same markets on every run. Those rows can't be trusted
 * as positions, so they are kept in the journal for reference (no `kind`, no
 * positionId) and the v2 book starts flat.
 */
function migrateV1(v1: PaperLedgerV1, demo: boolean): PaperLedger {
  const ledger = emptyLedger(demo);
  ledger.fills.push(...(v1.fills ?? []));
  ledger.migratedFromV1 = { at: new Date().toISOString(), legacyFills: v1.fills?.length ?? 0 };
  return ledger;
}

/**
 * Load a ledger. A missing file starts empty; an unreadable or corrupt file
 * throws rather than being silently replaced (which would erase paper history).
 */
export async function loadLedger(filePath: string, opts: { demo: boolean }): Promise<PaperLedger> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyLedger(opts.demo);
    throw err;
  }
  let data: PaperLedger | PaperLedgerV1;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Paper ledger ${filePath} is not valid JSON (${(err as Error).message}). ` +
        "Fix or move it aside; refusing to overwrite.",
    );
  }
  const ledger = data.version === 1 ? migrateV1(data, opts.demo) : (data as PaperLedger);
  if (ledger.version !== 2) {
    throw new Error(`Unsupported paper ledger version ${String((data as { version?: unknown }).version)} in ${filePath}`);
  }
  if (!!ledger.demo !== opts.demo) {
    throw new Error(
      `Paper ledger ${filePath} holds ${ledger.demo ? "DEMO fixture" : "real market"} positions; ` +
        `refusing to mix with a ${opts.demo ? "--demo" : "real-data"} run. Pass --ledger <path> to use a different file.`,
    );
  }
  ledger.positions ??= [];
  ledger.fills ??= [];
  ledger.ruleState ??= {};
  ledger.lastPrices ??= {};
  return ledger;
}

/** Atomic, durable write: temp file + fsync + rename, so a crash can't leave half a ledger. */
export async function saveLedger(filePath: string, ledger: PaperLedger): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.${process.pid}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(`${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, filePath);
}

interface LockInfo {
  pid: number;
  token: string;
  at: string;
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM"; // exists, owned by someone else
  }
}

async function readLock(lockPath: string): Promise<LockInfo | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as LockInfo;
  } catch {
    return null; // missing, or a half-written / foreign file
  }
}

/**
 * Single-writer lock so overlapping paper runs (cron, --loop) can't clobber each other.
 * A lock is stale when its process is gone (e.g. killed with Ctrl+C) or it is older than
 * 15 minutes. Stale locks are taken over by an atomic rename, so two racing runs can't
 * both claim it, and a run only ever deletes the lock carrying its own token.
 */
export async function withLedgerLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const lockPath = `${filePath}.lock`;
  const token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try {
      const fh = await open(lockPath, "wx");
      await fh.writeFile(JSON.stringify({ pid: process.pid, token, at: new Date().toISOString() } satisfies LockInfo));
      await fh.close();
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST" || attempt >= 2) {
        throw new Error(
          `Paper ledger is locked (${lockPath}). Another paper run may be in progress; ` +
            "if not, delete the lock file.",
        );
      }
      const info = await readLock(lockPath);
      const ageMs = await stat(lockPath).then((s) => Date.now() - s.mtimeMs, () => 0);
      const stale = ageMs > LOCK_STALE_MS || (info != null && info.pid !== process.pid && !pidAlive(info.pid));
      if (!stale) {
        throw new Error(
          `Paper ledger is locked by another run (pid ${info?.pid ?? "?"}, ${Math.round(ageMs / 1000)}s old): ${lockPath}`,
        );
      }
      // Atomic takeover: only one racer's rename succeeds; the loser retries and sees the new lock.
      await rename(lockPath, `${lockPath}.stale-${token}`)
        .then(() => unlink(`${lockPath}.stale-${token}`))
        .catch(() => undefined);
    }
  }
  try {
    return await fn();
  } finally {
    const info = await readLock(lockPath);
    if (info?.token === token) await unlink(lockPath).catch(() => undefined);
  }
}

export function openPositions(ledger: PaperLedger, ruleId?: string): PaperPosition[] {
  return ledger.positions.filter((p) => p.status === "open" && (ruleId == null || p.ruleId === ruleId));
}

export function findOpenPosition(
  ledger: PaperLedger,
  ruleId: string,
  platform: PlatformId,
  marketId: string,
): PaperPosition | undefined {
  return ledger.positions.find(
    (p) => p.status === "open" && p.ruleId === ruleId && p.platform === platform && p.marketId === marketId,
  );
}

/** Most recent exit time for this rule + market, if any. */
export function lastExitAt(
  ledger: PaperLedger,
  ruleId: string,
  platform: PlatformId,
  marketId: string,
): string | undefined {
  let latest: string | undefined;
  for (const p of ledger.positions) {
    if (p.status !== "closed" || !p.exitAt) continue;
    if (p.ruleId !== ruleId || p.platform !== platform || p.marketId !== marketId) continue;
    if (!latest || p.exitAt > latest) latest = p.exitAt;
  }
  return latest;
}

export function openPosition(
  ledger: PaperLedger,
  input: {
    ruleId: string;
    platform: PlatformId;
    marketId: string;
    title: string;
    url?: string;
    side: SignalSide;
    price: number;
    sizeUsd: number;
    feeUsd?: number;
    at?: Date;
    groupId?: string;
  },
): PaperPosition {
  if (!(input.price > 0 && input.price < 1)) {
    throw new Error(`Paper entry price must be between 0 and 1 (got ${input.price})`);
  }
  if (!(input.sizeUsd > 0)) throw new Error(`Paper entry size must be > 0 (got ${input.sizeUsd})`);
  const at = (input.at ?? new Date()).toISOString();
  const contracts = input.sizeUsd / input.price;
  const pos: PaperPosition = {
    id: randomUUID(),
    ruleId: input.ruleId,
    platform: input.platform,
    marketId: input.marketId,
    title: input.title,
    url: input.url,
    side: input.side,
    status: "open",
    entryAt: at,
    entryPrice: input.price,
    contracts,
    costUsd: input.sizeUsd,
    entryFeeUsd: input.feeUsd ?? 0,
    lastMarkPrice: input.price,
    lastMarkAt: at,
    marketStatus: "open",
    unrealizedPnlUsd: -(input.feeUsd ?? 0),
    groupId: input.groupId,
    hypothetical: true,
  };
  ledger.positions.push(pos);
  ledger.fills.push({
    id: randomUUID(),
    at,
    ruleId: pos.ruleId,
    platform: pos.platform,
    marketId: pos.marketId,
    title: pos.title,
    side: pos.side,
    price: pos.entryPrice,
    sizeUsd: pos.costUsd,
    hypothetical: true,
    kind: "open",
    positionId: pos.id,
    contracts,
    feeUsd: pos.entryFeeUsd,
  });
  return pos;
}

export function markPosition(
  pos: PaperPosition,
  markPrice: number,
  at: Date,
  marketStatus: PaperPosition["marketStatus"] = "open",
): void {
  pos.lastMarkPrice = markPrice;
  pos.lastMarkAt = at.toISOString();
  pos.marketStatus = marketStatus;
  pos.unrealizedPnlUsd = round2(pos.contracts * markPrice - pos.costUsd - pos.entryFeeUsd);
}

/** Close a position and journal the exit. Returns realized PnL in USD. */
export function closePosition(
  ledger: PaperLedger,
  pos: PaperPosition,
  exit: { price: number; at: Date; reason: PaperExitReason; detail?: string; feeUsd?: number },
): number {
  if (pos.status !== "open") throw new Error(`Paper position ${pos.id} is already closed`);
  const price = Math.min(1, Math.max(0, exit.price));
  const proceeds = pos.contracts * price;
  const exitFee = exit.feeUsd ?? 0;
  const pnl = round2(proceeds - pos.costUsd - pos.entryFeeUsd - exitFee);
  const at = exit.at.toISOString();
  Object.assign(pos, {
    status: "closed" as const,
    exitAt: at,
    exitPrice: price,
    exitFeeUsd: exitFee,
    exitReason: exit.reason,
    exitDetail: exit.detail,
    realizedPnlUsd: pnl,
    lastMarkPrice: price,
    lastMarkAt: at,
    unrealizedPnlUsd: 0,
  });
  if (exit.reason === "resolved") pos.marketStatus = "resolved";
  ledger.fills.push({
    id: randomUUID(),
    at,
    ruleId: pos.ruleId,
    platform: pos.platform,
    marketId: pos.marketId,
    title: pos.title,
    side: pos.side,
    price,
    sizeUsd: round2(proceeds),
    hypothetical: true,
    kind: "close",
    positionId: pos.id,
    contracts: pos.contracts,
    feeUsd: exitFee,
    pnlUsd: pnl,
    reason: exit.reason,
  });
  return pnl;
}

/** Rebuild a rule's risk state from the ledger (single source of truth across runs). */
export function riskStateFromLedger(ledger: PaperLedger, ruleId: string, now = new Date()): RiskState {
  const dayKey = dayKeyLA(now);
  let openCount = 0;
  let exposure = 0;
  let realized = 0;
  let dayPnl = 0;
  const openGroups = new Set<string>();
  for (const p of ledger.positions) {
    if (p.ruleId !== ruleId) continue;
    if (p.status === "open") {
      // An arbitrage group is one position however many legs it has.
      if (p.groupId) openGroups.add(p.groupId);
      else openCount += 1;
      exposure += p.costUsd;
    } else {
      realized += p.realizedPnlUsd ?? 0;
      if (p.exitAt && dayKeyLA(new Date(p.exitAt)) === dayKey) dayPnl += p.realizedPnlUsd ?? 0;
    }
  }
  const rs = ledger.ruleState[ruleId];
  return {
    consecutiveLosses: rs?.consecutiveLosses ?? 0,
    pausedUntil: rs?.pausedUntil,
    openPositions: openCount + openGroups.size,
    dayKey,
    dayPnlUsd: round2(dayPnl),
    openExposureUsd: round2(exposure),
    realizedPnlUsd: round2(realized),
  };
}

export function pruneLastPrices(ledger: PaperLedger, now = new Date()): void {
  const cutoff = now.getTime() - LAST_PRICE_MAX_AGE_HOURS * 3600_000;
  for (const [k, v] of Object.entries(ledger.lastPrices)) {
    if (new Date(v.at).getTime() < cutoff) delete ledger.lastPrices[k];
  }
}

export interface RuleSummary {
  ruleId: string;
  open: number;
  exposureUsd: number;
  unrealizedPnlUsd: number;
  closed: number;
  wins: number;
  losses: number;
  realizedPnlUsd: number;
  feesUsd: number;
  consecutiveLosses: number;
  pausedUntil?: string;
}

export function summarizeLedger(ledger: PaperLedger): { rules: RuleSummary[]; total: RuleSummary } {
  const by = new Map<string, RuleSummary>();
  const blank = (ruleId: string): RuleSummary => ({
    ruleId,
    open: 0,
    exposureUsd: 0,
    unrealizedPnlUsd: 0,
    closed: 0,
    wins: 0,
    losses: 0,
    realizedPnlUsd: 0,
    feesUsd: 0,
    consecutiveLosses: ledger.ruleState[ruleId]?.consecutiveLosses ?? 0,
    pausedUntil: ledger.ruleState[ruleId]?.pausedUntil,
  });
  const openGroups = new Map<string, Set<string>>();
  for (const p of ledger.positions) {
    const s = by.get(p.ruleId) ?? blank(p.ruleId);
    by.set(p.ruleId, s);
    s.feesUsd += p.entryFeeUsd + (p.exitFeeUsd ?? 0);
    if (p.status === "open") {
      if (p.groupId) {
        const set = openGroups.get(p.ruleId) ?? new Set<string>();
        set.add(p.groupId);
        openGroups.set(p.ruleId, set);
      } else s.open += 1;
      s.exposureUsd += p.costUsd;
      s.unrealizedPnlUsd += p.unrealizedPnlUsd ?? 0;
    } else {
      const pnl = p.realizedPnlUsd ?? 0;
      s.realizedPnlUsd += pnl;
      // Arbitrage legs are scored as one trade per group (below): one leg always "loses".
      if (p.groupId) continue;
      s.closed += 1;
      if (pnl > 0) s.wins += 1;
      else if (pnl < 0) s.losses += 1;
    }
  }
  for (const [ruleId, set] of openGroups) by.get(ruleId)!.open += set.size;
  for (const g of Object.values(ledger.arbGroups ?? {})) {
    if (g.status !== "closed") continue;
    const s = by.get(g.ruleId) ?? blank(g.ruleId);
    by.set(g.ruleId, s);
    s.closed += 1;
    if ((g.realizedPnlUsd ?? 0) > 0) s.wins += 1;
    else if ((g.realizedPnlUsd ?? 0) < 0) s.losses += 1;
  }
  const rules = [...by.values()].map(roundSummary).sort((a, b) => a.ruleId.localeCompare(b.ruleId));
  const total = rules.reduce<RuleSummary>(
    (t, s) => ({
      ...t,
      open: t.open + s.open,
      exposureUsd: t.exposureUsd + s.exposureUsd,
      unrealizedPnlUsd: t.unrealizedPnlUsd + s.unrealizedPnlUsd,
      closed: t.closed + s.closed,
      wins: t.wins + s.wins,
      losses: t.losses + s.losses,
      realizedPnlUsd: t.realizedPnlUsd + s.realizedPnlUsd,
      feesUsd: t.feesUsd + s.feesUsd,
    }),
    { ...blank("TOTAL"), consecutiveLosses: 0, pausedUntil: undefined },
  );
  return { rules, total: roundSummary(total) };
}

function roundSummary(s: RuleSummary): RuleSummary {
  return {
    ...s,
    exposureUsd: round2(s.exposureUsd),
    unrealizedPnlUsd: round2(s.unrealizedPnlUsd),
    realizedPnlUsd: round2(s.realizedPnlUsd),
    feesUsd: round2(s.feesUsd),
  };
}

export async function listPaperFills(filePath = path.resolve(DEFAULT_LEDGER)): Promise<PaperFill[]> {
  try {
    const data = JSON.parse(await readFile(filePath, "utf8")) as { fills?: PaperFill[] };
    return data.fills ?? [];
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
