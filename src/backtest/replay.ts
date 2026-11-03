import { kalshiTakerFeeUsd } from "../platforms/kalshi.js";
import { polymarketUsTakerFeeUsd } from "../platforms/polymarket-us.js";
import type { ListMarketsOptions, PlatformAdapter } from "../platforms/types.js";
import type { NormalizedMarket, PlatformId } from "../types.js";
import type { HistMarket, HistPoint } from "./history.js";

/**
 * A read-only adapter that answers "what did the market look like at time t?" from recorded
 * history, so the normal paper engine can be replayed hour by hour. It only ever sees prices at
 * or before t (no peeking ahead), and settles a market at its close with the real result.
 */
export class ReplayAdapter implements PlatformAdapter {
  private readonly byId: Map<string, HistMarket>;

  constructor(
    readonly id: PlatformId,
    markets: HistMarket[],
    private readonly clock: () => Date,
    /** A quote older than this is treated as gone (no bid / ask). */
    private readonly staleSec = 2 * 3600,
  ) {
    this.byId = new Map(markets.filter((m) => m.market.platform === id).map((m) => [m.market.id, m]));
  }

  private at(): number {
    return Math.floor(this.clock().getTime() / 1000);
  }

  /** The market as it looked at the replay time, or null before it had any price. */
  snapshot(h: HistMarket, t = this.at()): NormalizedMarket | null {
    const p = lastAtOrBefore(h.points, t);
    if (!p) return null;
    let closeS = h.market.closesAt ? Math.floor(Date.parse(h.market.closesAt) / 1000) : Infinity;
    // A settled market stops trading when the result is known, which can be well before its
    // scheduled close: settle it once its prices run out instead of holding it to that date.
    if (h.result) closeS = Math.min(closeS, h.points[h.points.length - 1][0] + this.staleSec);
    const base: NormalizedMarket = { ...h.market, yesBid: undefined, yesAsk: undefined, quotedAt: undefined };
    if (t >= closeS) {
      if (h.result?.outcome) return { ...base, status: "resolved", resolvedOutcome: h.result.outcome, yesPrice: h.result.outcome === "yes" ? 1 : 0, noPrice: h.result.outcome === "yes" ? 0 : 1 };
      if (h.result?.yesPayout != null) return { ...base, status: "resolved", settlementYesPrice: h.result.yesPayout, yesPrice: h.result.yesPayout, noPrice: 1 - h.result.yesPayout };
      return { ...base, status: "closed" };
    }
    const [ts, bid, ask, vol24, oi] = p;
    const fresh = t - ts <= this.staleSec;
    const b = fresh && bid != null ? bid : undefined;
    const a = fresh && ask != null && (b == null || ask >= b) ? ask : undefined;
    const yes = b != null && a != null ? (b + a) / 2 : (a ?? b ?? (bid != null && ask != null ? (bid + ask) / 2 : (ask ?? bid)));
    if (yes == null) return null;
    const out: NormalizedMarket = { ...base, status: "open", yesBid: b, yesAsk: a, yesPrice: yes, noPrice: 1 - yes };
    if (this.id === "kalshi") {
      // The live Kalshi adapter uses open interest as liquidity and 24h volume in contracts.
      out.liquidityUsd = oi ?? undefined;
      out.volume24hUsd = vol24 ?? undefined;
    }
    return out;
  }

  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    const t = this.at();
    const out: NormalizedMarket[] = [];
    for (const h of this.byId.values()) {
      const m = this.snapshot(h, t);
      if (m && m.status === "open") out.push(m);
    }
    // Busiest first, like the live listings.
    out.sort((x, y) => (y.volume24hUsd ?? y.liquidityUsd ?? 0) - (x.volume24hUsd ?? x.liquidityUsd ?? 0));
    return opts.limit ? out.slice(0, opts.limit) : out;
  }

  async getMarket(id: string): Promise<NormalizedMarket | null> {
    const h = this.byId.get(id);
    return h ? this.snapshot(h) : null;
  }

  async getMarkets(ids: string[]): Promise<NormalizedMarket[]> {
    return (await Promise.all(ids.map((i) => this.getMarket(i)))).filter((m): m is NormalizedMarket => !!m);
  }

  estimateTakerFeeUsd(contracts: number, price: number, market?: NormalizedMarket): number {
    return this.id === "kalshi" ? kalshiTakerFeeUsd(contracts, price) : polymarketUsTakerFeeUsd(contracts, price, market?.takerFeeRate);
  }

  roundContracts(contracts: number): number {
    return Math.floor(contracts + 1e-9);
  }
}

/** Binary search for the last point at or before t (points are sorted by time). */
export function lastAtOrBefore(points: HistPoint[], t: number): HistPoint | undefined {
  let lo = 0;
  let hi = points.length - 1;
  let hit: HistPoint | undefined;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid][0] <= t) {
      hit = points[mid];
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return hit;
}
