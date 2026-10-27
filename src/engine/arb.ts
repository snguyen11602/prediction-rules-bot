import path from "node:path";
import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { ArbPairsFileSchema, type ArbitrageConfig, type ArbPairsFile } from "../rules/schema.js";
import type { EventGroup } from "../platforms/types.js";
import type { NormalizedMarket, PlatformId, SignalSide } from "../types.js";
import { hoursToResolve } from "./evaluate.js";
import { findMatches, type MatchCandidate } from "./match.js";
import { buyPrice, sellPrice } from "./pricing.js";

/**
 * Arbitrage = a set of contracts whose combined payout is guaranteed, bought
 * for less than that payout. Platform-agnostic: a basket is just legs
 * (market + side) and a guaranteed payout per set.
 *
 *  cross_platform  same question on two platforms: YES on one + NO on the other → pays $1.
 *  no_basket       mutually exclusive outcomes: NO on each of N → at least N − 1 pay $1.
 *  yes_basket      exactly-one-wins outcomes: YES on all N → exactly one pays $1.
 */

export type ArbKind = "cross_platform" | "no_basket" | "yes_basket";

export interface ArbLegSpec {
  market: NormalizedMarket;
  side: SignalSide;
}

export interface ArbBasket {
  /** Stable id for cool-downs and de-duplication (shared by both directions of a pair). */
  key: string;
  kind: ArbKind;
  title: string;
  legs: ArbLegSpec[];
  /** Guaranteed payout per set (one contract of every leg). */
  payoutPerSet: number;
  matchedBy: "confirmed" | "auto" | "platform";
  score?: number;
  url?: string;
}

export interface ArbQuoteLeg extends ArbLegSpec {
  /** Buy price incl. slippage (0–1). */
  price: number;
  feeUsd: number;
}

export interface ArbQuote {
  basket: ArbBasket;
  legs: ArbQuoteLeg[];
  sets: number;
  costUsd: number;
  feesUsd: number;
  payoutUsd: number;
  profitUsd: number;
  /** Profit per $1 of guaranteed payout. */
  edge: number;
  hoursToResolve?: number;
  /** Profit / capital, scaled to a year. Small edges held for months are poor returns. */
  annualizedReturn?: number;
}

export interface QuoteEnv {
  slippage: number;
  includeFees: boolean;
  feeFor: (market: NormalizedMarket, contracts: number, price: number) => number;
  roundSets: (platforms: PlatformId[], sets: number) => number;
  now: Date;
}

const opposite = (s: SignalSide): SignalSide => (s === "yes" ? "no" : "yes");
const round2 = (n: number) => Math.round(n * 100) / 100;

function quoted(m: NormalizedMarket): boolean {
  // Arbs need real, executable quotes on both sides of the book — never a mid.
  return (m.status ?? "open") === "open" && m.yesBid != null && m.yesAsk != null;
}

export function pairKey(kalshiId: string, polymarketId: string): string {
  return `x|kalshi:${kalshiId}|polymarket:${polymarketId}`;
}

/** The pairs file must live in the rules folder (it's rewritten by arb:confirm / arb:block). */
export function pairsFilePath(rulesPath: string, cfg: ArbitrageConfig): string {
  const dir = path.dirname(path.resolve(rulesPath));
  const file = path.resolve(dir, cfg.cross_platform.pairs_file);
  const rel = path.relative(dir, file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || !/\.ya?ml$/i.test(file)) {
    throw new Error(`arbitrage.cross_platform.pairs_file must be a .yaml file inside ${dir}`);
  }
  return file;
}

/** Missing file → no pairs. Invalid file → throws (don't silently trade without blocks). */
export async function loadPairsFile(file: string): Promise<ArbPairsFile> {
  let raw: string;
  try {
    raw = await readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { confirmed: [], blocked: [] };
    throw err;
  }
  let data: unknown;
  try {
    data = parseYaml(raw);
  } catch (err) {
    // Don't echo file contents into logs / webhooks.
    const line = (err as { linePos?: Array<{ line: number }> }).linePos?.[0]?.line;
    throw new Error(`${path.basename(file)} is not valid YAML${line ? ` (line ${line})` : ""}`);
  }
  const parsed = ArbPairsFileSchema.safeParse(data ?? {});
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`${path.basename(file)}: ${issue?.path.join(".") || "file"} ${issue?.message ?? "is invalid"}`);
  }
  return parsed.data;
}

/** Price one basket for `sizeUsd` of capital (or a fixed number of sets). */
export function quoteBasket(basket: ArbBasket, size: { sizeUsd: number } | { sets: number }, env: QuoteEnv): ArbQuote | null {
  if (basket.legs.length < 2 || !basket.legs.every((l) => quoted(l.market))) return null;
  const prices = basket.legs.map((l) => buyPrice(l.market, l.side, env.slippage));
  if (!prices.every((p) => p > 0 && p < 1)) return null;
  const perSet = prices.reduce((a, b) => a + b, 0);
  if (!(perSet < basket.payoutPerSet)) return null;

  const platforms = basket.legs.map((l) => l.market.platform);
  const feesFor = (n: number) =>
    basket.legs.map((l, i) => (env.includeFees ? env.feeFor(l.market, n, prices[i]) : 0));
  let sets = env.roundSets(platforms, "sets" in size ? size.sets : size.sizeUsd / perSet);
  if ("sizeUsd" in size) {
    // Fees count toward the position size: shrink until cost + fees fit.
    for (let i = 0; i < 20 && sets > 0; i++) {
      const total = sets * perSet + feesFor(sets).reduce((a, b) => a + b, 0);
      if (total <= size.sizeUsd + 1e-9) break;
      sets = env.roundSets(platforms, sets * (size.sizeUsd / total) - 1e-9);
    }
  }
  if (!(sets > 0)) return null;

  const fees = feesFor(sets);
  const legs: ArbQuoteLeg[] = basket.legs.map((l, i) => ({ ...l, price: prices[i], feeUsd: fees[i] }));
  const costUsd = round2(sets * perSet);
  const feesUsd = round2(legs.reduce((a, l) => a + l.feeUsd, 0));
  const payoutUsd = round2(sets * basket.payoutPerSet);
  const profitUsd = round2(payoutUsd - costUsd - feesUsd);
  const hrs = basket.legs
    .map((l) => hoursToResolve(l.market, env.now))
    .filter((h): h is number => h != null);
  const hoursMax = hrs.length ? Math.max(...hrs) : undefined;
  return {
    basket,
    legs,
    sets,
    costUsd,
    feesUsd,
    payoutUsd,
    profitUsd,
    edge: payoutUsd > 0 ? profitUsd / payoutUsd : 0,
    hoursToResolve: hoursMax,
    annualizedReturn:
      hoursMax != null && hoursMax > 0 && costUsd + feesUsd > 0
        ? (profitUsd / (costUsd + feesUsd)) * (8760 / hoursMax)
        : undefined,
  };
}

/** What selling every leg right now would return, after exit fees. Null if any leg can't be sold. */
export function unwindProceeds(
  legs: Array<{ market: NormalizedMarket; side: SignalSide; contracts: number }>,
  env: QuoteEnv,
): { proceedsUsd: number; prices: number[]; fees: number[] } | null {
  if (!legs.every((l) => quoted(l.market))) return null;
  const prices = legs.map((l) => sellPrice(l.market, l.side, env.slippage));
  const fees = legs.map((l, i) => (env.includeFees ? env.feeFor(l.market, l.contracts, prices[i]) : 0));
  const gross = legs.reduce((a, l, i) => a + l.contracts * prices[i], 0);
  return { proceedsUsd: round2(gross - fees.reduce((a, b) => a + b, 0)), prices, fees };
}

export interface DiscoverInput {
  cfg: ArbitrageConfig;
  pairs: ArbPairsFile;
  /** Market listings from both platforms. */
  markets: NormalizedMarket[];
  /** Fetch one market by id (confirmed pairs that aren't in the listing). */
  lookup?: (platform: PlatformId, id: string) => Promise<NormalizedMarket | null>;
  eventGroups: EventGroup[];
}

export interface Discovery {
  baskets: ArbBasket[];
  /** Automatic cross-platform matches (accepted ones), for review tools. */
  candidates: MatchCandidate[];
  skipped: Array<{ key: string; title: string; reason: string }>;
}

export function crossBaskets(
  k: NormalizedMarket,
  p: NormalizedMarket,
  invert: boolean,
  matchedBy: "confirmed" | "auto",
  score?: number,
): ArbBasket[] {
  const key = pairKey(k.id, p.id);
  const title = `${k.title} ↔ ${p.title}`;
  return (["yes", "no"] as const).map((kSide) => ({
    key,
    kind: "cross_platform" as const,
    title,
    legs: [
      { market: k, side: kSide },
      { market: p, side: invert ? kSide : opposite(kSide) },
    ],
    payoutPerSet: 1,
    matchedBy,
    score,
    url: k.url,
  }));
}

export async function discoverBaskets(input: DiscoverInput): Promise<Discovery> {
  const { cfg, pairs } = input;
  const baskets: ArbBasket[] = [];
  const skipped: Discovery["skipped"] = [];
  let candidates: MatchCandidate[] = [];

  if (cfg.cross_platform.enabled) {
    const byKey = new Map(input.markets.map((m) => [`${m.platform}:${m.id}`, m]));
    const get = async (platform: PlatformId, id: string) =>
      byKey.get(`${platform}:${id}`) ?? (input.lookup ? await input.lookup(platform, id) : null);
    const blocked = new Set(pairs.blocked.map((b) => pairKey(b.kalshi, b.polymarket)));
    const claimed = new Set<string>();

    for (const c of pairs.confirmed) {
      const key = pairKey(c.kalshi, c.polymarket);
      if (blocked.has(key)) continue;
      const [k, p] = await Promise.all([get("kalshi", c.kalshi), get("polymarket", c.polymarket)]);
      claimed.add(`kalshi:${c.kalshi}`);
      claimed.add(`polymarket:${c.polymarket}`);
      if (!k || !p) {
        skipped.push({ key, title: c.note ?? key, reason: `market not found (${!k ? "Kalshi" : "Polymarket"})` });
        continue;
      }
      baskets.push(...crossBaskets(k, p, c.invert, "confirmed"));
    }

    if (cfg.cross_platform.auto_match) {
      candidates = findMatches(
        input.markets.filter((m) => m.platform === "kalshi" && !claimed.has(`kalshi:${m.id}`)),
        input.markets.filter((m) => m.platform === "polymarket" && !claimed.has(`polymarket:${m.id}`)),
        {
          minScore: cfg.cross_platform.min_score,
          maxCloseGapHours: cfg.cross_platform.max_close_gap_hours,
          // Blocked pairs never compete for a market in the one-to-one assignment.
          exclude: new Set(pairs.blocked.map((b) => `${b.kalshi}|${b.polymarket}`)),
        },
      );
      for (const c of candidates) {
        const key = pairKey(c.kalshi.id, c.polymarket.id);
        if (blocked.has(key)) continue;
        const gap = Math.abs(c.kalshi.yesPrice - c.polymarket.yesPrice);
        if (gap > cfg.cross_platform.max_price_gap) {
          skipped.push({
            key,
            title: `${c.kalshi.title} ↔ ${c.polymarket.title}`,
            reason: `prices ${Math.round(gap * 100)}¢ apart — probably not the same question (confirm it to trade)`,
          });
          continue;
        }
        baskets.push(...crossBaskets(c.kalshi, c.polymarket, false, "auto", c.score));
      }
    }
  }

  if (cfg.same_platform.enabled) {
    for (const g of input.eventGroups) {
      if (!g.mutuallyExclusive) continue;
      // An outcome already resolved YES means the event is decided; remaining quotes are stale.
      if (g.markets.some((m) => m.status === "resolved" && (m.resolvedOutcome === "yes" || m.settlementYesPrice != null))) continue;
      const open = g.markets.filter((m) => (m.status ?? "open") === "open");
      const nonOpen = g.markets.filter((m) => (m.status ?? "open") !== "open");
      if (open.length < 2 || open.length > cfg.same_platform.max_outcomes) continue;
      const withQuotes = open.filter(quoted);
      const base = { matchedBy: "platform" as const, payoutPerSet: 1, url: g.url };

      if (cfg.same_platform.no_basket && withQuotes.length >= 2) {
        // Any subset of mutually exclusive outcomes has at most one YES, so NO on
        // each of k of them pays at least k − 1. Leave out outcomes whose YES bid is
        // too small to help (they'd only add slippage and fees).
        const legs = withQuotes.filter((m) => (m.yesBid ?? 0) > cfg.paper.slippage + 0.005);
        if (legs.length >= 2) {
          baskets.push({
            ...base,
            key: `n|${g.platform}:${g.eventId}`,
            kind: "no_basket",
            title: `${g.title} — NO on ${legs.length} outcomes`,
            legs: legs.map((m) => ({ market: m, side: "no" as const })),
            payoutPerSet: legs.length - 1,
          });
        }
      }
      if (cfg.same_platform.yes_basket && g.exhaustive) {
        // Every outcome that can still win is needed, and every other one must have resolved NO.
        const othersSettledNo = nonOpen.every((m) => m.status === "resolved" && m.resolvedOutcome === "no");
        if (withQuotes.length === open.length && othersSettledNo) {
          baskets.push({
            ...base,
            key: `y|${g.platform}:${g.eventId}`,
            kind: "yes_basket",
            title: `${g.title} — YES on all ${open.length} outcomes`,
            legs: open.map((m) => ({ market: m, side: "yes" as const })),
          });
        }
      }
    }
  }

  return { baskets, candidates, skipped };
}

/** Best-priced quote per basket key (both directions of a pair share a key), best edge first. */
export function bestQuotes(baskets: ArbBasket[], sizeUsd: number, env: QuoteEnv): ArbQuote[] {
  const best = new Map<string, ArbQuote>();
  for (const b of baskets) {
    const q = quoteBasket(b, { sizeUsd }, env);
    if (!q) continue;
    const prev = best.get(b.key);
    if (!prev || q.edge > prev.edge) best.set(b.key, q);
  }
  return [...best.values()].sort((a, b) => b.edge - a.edge);
}

export function kindLabel(kind: ArbKind): string {
  return kind === "cross_platform" ? "Kalshi ↔ Polymarket" : kind === "no_basket" ? "Same site: NO on every outcome" : "Same site: YES on every outcome";
}
