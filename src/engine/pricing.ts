import type { NormalizedMarket, SignalSide } from "../types.js";

/**
 * Paper fill prices for the HELD side, platform-agnostic.
 * Uses YES bid/ask when the adapter provides them (NO quotes are the
 * complement: NO ask = 1 − YES bid, NO bid = 1 − YES ask), else the mid.
 * `slippage` is applied against you on both entry and exit.
 */

function clamp01(n: number): number {
  return Math.min(1, Math.max(0, n));
}

/** Price you would pay to buy `side` now. */
export function buyPrice(market: NormalizedMarket, side: SignalSide, slippage = 0): number {
  const base =
    side === "yes"
      ? market.yesAsk ?? market.yesPrice
      : market.yesBid != null
        ? 1 - market.yesBid
        : market.noPrice ?? 1 - market.yesPrice;
  return clamp01(base + slippage);
}

/** Price you would receive selling `side` now (also used to mark and trigger exits). */
export function sellPrice(market: NormalizedMarket, side: SignalSide, slippage = 0): number {
  const base =
    side === "yes"
      ? market.yesBid ?? market.yesPrice
      : market.yesAsk != null
        ? 1 - market.yesAsk
        : market.noPrice ?? 1 - market.yesPrice;
  return clamp01(base - slippage);
}

function hasQuotes(market: NormalizedMarket): boolean {
  return market.yesBid != null || market.yesAsk != null;
}

/**
 * Whether there is a real price to trade `side` in direction `dir`.
 * Adapters that provide no quotes at all fall back to the mid (true).
 * When quotes exist but the needed side of the book is empty, there is
 * nothing to trade against (false) — never treat an empty bid as a 0 price.
 */
export function canTrade(market: NormalizedMarket, side: SignalSide, dir: "buy" | "sell"): boolean {
  if (!hasQuotes(market)) return true;
  const needYesAsk = (side === "yes") === (dir === "buy");
  return needYesAsk ? market.yesAsk != null : market.yesBid != null;
}

/** Settlement value of `side` once the market has resolved. */
export function settlementPrice(market: NormalizedMarket, side: SignalSide): number | undefined {
  if (market.status !== "resolved") return undefined;
  const yesPayout =
    market.settlementYesPrice ??
    (market.resolvedOutcome === "yes" ? 1 : market.resolvedOutcome === "no" ? 0 : undefined);
  if (yesPayout == null) return undefined;
  return side === "yes" ? yesPayout : 1 - yesPayout;
}
