import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Rule, SharpLinesConfig } from "../rules/schema.js";
import type { NormalizedMarket } from "../types.js";
import { marketPassesFilters } from "../engine/evaluate.js";
import { fetchOdds, OddsApiError, type FetchLike } from "./odds-api.js";
import { fairFor, sportOf, type Fair, type SharpEvent } from "./sharp.js";

/**
 * Keeps sharp lines fresh on a small request budget (the free plan is 500 credits a month). A
 * sport is only requested when one of its games that a sharp rule could buy starts soon, at most
 * every `refresh_minutes`, and never past `max_credits_per_day`. Lines are cached next to the
 * ledger so a restart doesn't spend credits again.
 */

export interface SharpState {
  version: 1;
  /** UTC day the counter below is for. */
  day: string;
  usedToday: number;
  /** Credits left this month, as last reported by the service. */
  remaining?: number;
  /** Don't ask again before this time (bad key, out of credits). */
  blockedUntil?: string;
  blockedWhy?: string;
  sports: Record<string, { at: string; events: SharpEvent[] }>;
}

export function sharpPathFor(ledgerPath: string): string {
  return ledgerPath.replace(/\.json$/, "") + ".sharp.json";
}

export async function loadSharpState(file: string): Promise<SharpState> {
  try {
    const s = JSON.parse(await readFile(file, "utf8")) as SharpState;
    if (s?.version === 1 && s.sports) return s;
  } catch {
    // first run, or an unreadable cache: start clean
  }
  return { version: 1, day: "", usedToday: 0, sports: {} };
}

async function saveSharpState(file: string, s: SharpState): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(s));
  await rename(tmp, file);
}

export interface SharpResult {
  /** Fair value by market key (`platform:id`). */
  fair: Map<string, Fair>;
  /** Why a market has none (for the trade trace). */
  why: Map<string, string>;
  /** One-line notes for the event feed (requests made, problems). */
  notes: string[];
  problems: string[];
}

export interface SharpDeps {
  key?: string;
  fetchImpl?: FetchLike;
  /** false = use the cache only (quick checks). */
  mayFetch?: boolean;
}

export async function loadSharp(
  cfg: SharpLinesConfig | undefined,
  rules: Rule[],
  markets: NormalizedMarket[],
  statePath: string,
  now: Date,
  deps: SharpDeps = {},
): Promise<SharpResult> {
  const out: SharpResult = { fair: new Map(), why: new Map(), notes: [], problems: [] };
  const users = rules.filter((r) => r.enabled && r.entry.sharp_edge);
  if (!cfg?.enabled || !users.length) return out;
  const nowMs = now.getTime();
  const key = deps.key ?? process.env.ODDS_API_KEY?.trim();
  const state = await loadSharpState(statePath);
  const today = now.toISOString().slice(0, 10);
  if (state.day !== today) {
    state.day = today;
    state.usedToday = 0;
  }
  let dirty = false;

  // Games a sharp rule could buy, by sport, with the soonest start.
  const candidates = markets.filter((m) => {
    const start = m.startsAt ? Date.parse(m.startsAt) : NaN;
    return Number.isFinite(start) && start > nowMs && sportOf(m) != null && users.some((r) => marketPassesFilters(r, m, now));
  });
  const soonest = new Map<string, number>();
  for (const m of candidates) {
    const sport = sportOf(m)!;
    const start = Date.parse(m.startsAt!);
    if (start - nowMs <= cfg.window_hours * 3600_000) soonest.set(sport, Math.min(soonest.get(sport) ?? Infinity, start));
  }

  const blocked = state.blockedUntil && Date.parse(state.blockedUntil) > nowMs;
  if (!key) {
    for (const m of candidates) out.why.set(`${m.platform}:${m.id}`, "no sharp line: add ODDS_API_KEY to .env");
  } else if (deps.mayFetch !== false && !blocked) {
    for (const [sport] of [...soonest].sort((a, b) => a[1] - b[1])) {
      const have = state.sports[sport];
      if (have && nowMs - Date.parse(have.at) < cfg.refresh_minutes * 60_000) continue;
      if (state.usedToday >= cfg.max_credits_per_day) {
        out.notes.push(`Sharp lines: today's ${cfg.max_credits_per_day} requests are used; ${sport} not refreshed`);
        break;
      }
      if (state.remaining != null && state.remaining <= 0) break;
      try {
        // `sports` can rename a league for the provider; events are filed under our own name for it.
        const res = await fetchOdds(cfg.sports?.[sport] ?? sport, key, { region: cfg.region, book: cfg.bookmaker, fetchImpl: deps.fetchImpl });
        state.sports[sport] = { at: now.toISOString(), events: res.events.map((e) => ({ ...e, sport })) };
        state.usedToday += res.cost ?? 1;
        if (res.remaining != null) state.remaining = res.remaining;
        state.blockedUntil = undefined;
        state.blockedWhy = undefined;
        dirty = true;
        out.notes.push(`Sharp lines: ${sport}, ${res.events.length} game(s)${res.remaining != null ? `, ${res.remaining} requests left this month` : ""}`);
      } catch (err) {
        const e = err as OddsApiError;
        const hard = e.code === "OUT_OF_USAGE_CREDITS" || /key/i.test(e.message);
        // Bad key or no credits: stop asking for a while instead of failing every minute.
        state.blockedUntil = new Date(nowMs + (hard ? 6 : 0.25) * 3600_000).toISOString();
        state.blockedWhy = e.message;
        dirty = true;
        out.problems.push(`Sharp lines: ${e.message}`);
        break;
      }
    }
  }
  // Drop games that started long ago so the cache stays small.
  for (const [sport, v] of Object.entries(state.sports)) {
    if (nowMs - Date.parse(v.at) > 24 * 3600_000) {
      delete state.sports[sport];
      dirty = true;
    }
  }
  if (dirty) await saveSharpState(statePath, state).catch(() => undefined);

  const events = Object.values(state.sports).flatMap((s) => s.events);
  for (const m of candidates) {
    const k = `${m.platform}:${m.id}`;
    if (!key) continue;
    const f = fairFor(m, markets, events);
    if ("p" in f) out.fair.set(k, f);
    else out.why.set(k, blocked && state.blockedWhy ? `no sharp line: ${state.blockedWhy}` : f.reason);
  }
  return out;
}
