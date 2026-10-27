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

/** Settlement value of `side` once the market has resolved. */
export function settlementPrice(market: NormalizedMarket, side: SignalSide): number | undefined {
  if (market.status !== "resolved" || !market.resolvedOutcome) return undefined;
  return market.resolvedOutcome === side ? 1 : 0;
}
