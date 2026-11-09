import type { PlatformAdapter } from "../platforms/types.js";
import type { Rule } from "../rules/schema.js";
import type { NormalizedMarket, PlatformId } from "../types.js";
import { marketPassesFilters } from "./evaluate.js";
import type { Tick } from "./series.js";

/**
 * Hourly platform prices for the markets a `pregame_move` rule could buy right now: games that pass
 * the rule's filters and start within its window. A few dozen markets a day, one request per 40,
 * refreshed at most every 15 minutes (the cache lives as long as the process).
 */
const REFRESH_MS = 15 * 60_000;
const cache = new Map<string, { at: number; ticks: Tick[] }>();

export function clearHourlyCache(): void {
  cache.clear();
}

export async function loadHourly(
  rules: Rule[],
  markets: NormalizedMarket[],
  adapterFor: (id: PlatformId) => PlatformAdapter | undefined,
  now: Date,
): Promise<Map<string, Tick[]>> {
  const out = new Map<string, Tick[]>();
  const users = rules.filter((r) => r.enabled && r.entry.pregame_move);
  if (!users.length) return out;
  const nowMs = now.getTime();
  const want = new Map<PlatformId, { ids: Set<string>; lookback: number }>();
  for (const m of markets) {
    const start = m.startsAt ? Date.parse(m.startsAt) : NaN;
    if (!Number.isFinite(start) || start <= nowMs) continue;
    const key = `${m.platform}:${m.id}`;
    for (const r of users) {
      const cfg = r.entry.pregame_move!;
      if ((start - nowMs) / 3600_000 > cfg.max_hours_to_start || !marketPassesFilters(r, m, now)) continue;
      const hit = cache.get(key);
      if (hit && nowMs - hit.at < REFRESH_MS && nowMs >= hit.at) {
        out.set(key, hit.ticks);
        continue;
      }
      if (!adapterFor(m.platform)?.priceHistory) continue;
      const w = want.get(m.platform) ?? { ids: new Set<string>(), lookback: 0 };
      w.ids.add(m.id);
      w.lookback = Math.max(w.lookback, cfg.lookback_hours);
      want.set(m.platform, w);
    }
  }
  for (const [platform, w] of want) {
    try {
      const got = await adapterFor(platform)!.priceHistory!([...w.ids], nowMs - (w.lookback + 3) * 3600_000, nowMs);
      for (const id of w.ids) {
        const ticks = got.get(id) ?? [];
        cache.set(`${platform}:${id}`, { at: nowMs, ticks });
        out.set(`${platform}:${id}`, ticks);
      }
    } catch {
      // No history this time: the signal says so and the rule simply doesn't fire.
    }
  }
  // Forget games that have started.
  if (cache.size > 2000) for (const [k, v] of cache) if (nowMs - v.at > 6 * 3600_000) cache.delete(k);
  return out;
}
