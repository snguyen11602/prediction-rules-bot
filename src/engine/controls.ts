import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * Start / stop switches for the bots, set from the dashboard and read by every paper cycle.
 * A stopped bot makes no new trades; its open trades are still managed (exits, stops, settlement)
 * so nothing is left unwatched. Start on a bot paused after losses also lifts the pause.
 *
 * The dashboard is the only writer of this file; paper cycles only read it (a resume is applied to
 * the ledger once, tracked by `resumedAt` in the rule's state).
 */
export interface Controls {
  version: 1;
  /** Every bot stopped (no new trades anywhere). */
  allStopped: boolean;
  allStoppedAt?: string;
  /** Bot id → when it was stopped. */
  stopped: Record<string, string>;
  /** Bot id → when Start was pressed (lifts a loss pause once). */
  resumed: Record<string, string>;
  /**
   * "Reset portfolio" was pressed at this time. The next paper cycle (the only writer of the
   * ledger) archives the ledger and starts a new one, and notes this time on it so the same
   * request is applied once.
   */
  resetRequestedAt?: string;
  updatedAt?: string;
}

export function controlsPathFor(ledgerPath: string): string {
  return ledgerPath.replace(/\.json$/i, "") + ".controls.json";
}

export function emptyControls(): Controls {
  return { version: 1, allStopped: false, stopped: {}, resumed: {} };
}

/** Missing or unreadable → everything running (a bad file must never stop exits or crash a cycle). */
export async function loadControls(file: string): Promise<Controls> {
  try {
    const c = JSON.parse(await readFile(file, "utf8")) as Partial<Controls>;
    if (c?.version !== 1) return emptyControls();
    const map = (v: unknown) =>
      v && typeof v === "object" ? Object.fromEntries(Object.entries(v as Record<string, unknown>).filter(([, at]) => typeof at === "string")) as Record<string, string> : {};
    return {
      version: 1,
      allStopped: c.allStopped === true,
      allStoppedAt: typeof c.allStoppedAt === "string" ? c.allStoppedAt : undefined,
      stopped: map(c.stopped),
      resumed: map(c.resumed),
      resetRequestedAt: typeof c.resetRequestedAt === "string" ? c.resetRequestedAt : undefined,
      updatedAt: c.updatedAt,
    };
  } catch {
    return emptyControls();
  }
}

export async function saveControls(file: string, c: Controls): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, JSON.stringify(c, null, 2));
  await rename(tmp, file);
}

export function isStopped(c: Controls, id: string): boolean {
  return c.allStopped || c.stopped[id] != null;
}

export type ControlAction = { action: "start" | "stop" | "reset"; id?: string; all?: boolean };

/** Apply one button press. `all` switches every bot; Start also lifts loss pauses. */
export function applyControl(c: Controls, a: ControlAction, now: Date, knownIds: string[] = []): Controls {
  const at = now.toISOString();
  const next: Controls = { ...c, stopped: { ...c.stopped }, resumed: { ...c.resumed }, updatedAt: at };
  if (a.action === "reset") {
    next.resetRequestedAt = at;
    return next;
  }
  if (a.all) {
    if (a.action === "stop") {
      next.allStopped = true;
      next.allStoppedAt = at;
    } else {
      next.allStopped = false;
      next.allStoppedAt = undefined;
      next.stopped = {};
      for (const id of knownIds) next.resumed[id] = at;
    }
    return next;
  }
  if (!a.id) return next;
  if (a.action === "start" && next.allStopped) {
    // Starting one bot while all are stopped: the others stay stopped, one by one.
    next.allStopped = false;
    next.allStoppedAt = undefined;
    for (const id of knownIds) if (id !== a.id) next.stopped[id] ??= at;
  }
  if (a.action === "stop") next.stopped[a.id] = at;
  else {
    delete next.stopped[a.id];
    next.resumed[a.id] = at;
  }
  return next;
}
