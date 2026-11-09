import { kalshiMatchCode } from "../platforms/kalshi.js";
import type { NormalizedMarket } from "../types.js";

/**
 * Is this market about one game or match (winner, spread, total…)? Kalshi: the ticker carries a
 * date + teams code. Polymarket US: a game slug (aec- winner, asc- spread, tsc- total). Elsewhere:
 * a game winner, or a start time with the result expected within half a day of it.
 */
export function isGame(m: Pick<NormalizedMarket, "platform" | "id" | "marketType" | "startsAt" | "resolvesAt" | "raw">): boolean {
  if (m.marketType === "game_winner") return true;
  if (m.platform === "kalshi") return kalshiMatchCode(m.id) != null;
  const slug = (m.raw as { slug?: string } | undefined)?.slug;
  if (m.platform === "polymarket_us" && slug) return /^(aec|asc|tsc)-/.test(slug);
  const start = m.startsAt ? Date.parse(m.startsAt) : NaN;
  const end = m.resolvesAt ? Date.parse(m.resolvesAt) : NaN;
  return Number.isFinite(start) && Number.isFinite(end) && end - start <= 12 * 3600_000;
}
