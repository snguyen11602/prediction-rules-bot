import type { NormalizedMarket, PlatformId } from "../types.js";

/** Latest streamed top-of-book for one market (YES side, 0–1). */
export interface LiveQuote {
  bid?: number;
  ask?: number;
  last?: number;
  /** Epoch ms when we received it. */
  at: number;
}

/** In-memory latest quotes from the WebSocket streams, keyed by platform + market id. */
export class QuoteBook {
  private readonly quotes = new Map<string, LiveQuote>();
  private readonly listeners = new Set<(platform: PlatformId, id: string) => void>();
  updates = 0;

  static key(platform: PlatformId, id: string): string {
    return `${platform}:${id}`;
  }

  set(platform: PlatformId, id: string, q: Omit<LiveQuote, "at">, at = Date.now()): void {
    const prev = this.quotes.get(QuoteBook.key(platform, id));
    // A message may carry only some fields; keep the rest from the last update.
    this.quotes.set(QuoteBook.key(platform, id), {
      bid: "bid" in q ? q.bid : prev?.bid,
      ask: "ask" in q ? q.ask : prev?.ask,
      last: q.last ?? prev?.last,
      at,
    });
    this.updates += 1;
    for (const fn of this.listeners) fn(platform, id);
  }

  /** Drop a platform's quotes (its stream disconnected, so they may no longer be current). */
  clearPlatform(platform: PlatformId): void {
    for (const k of [...this.quotes.keys()]) if (k.startsWith(`${platform}:`)) this.quotes.delete(k);
  }

  get(platform: PlatformId, id: string): LiveQuote | undefined {
    return this.quotes.get(QuoteBook.key(platform, id));
  }

  onUpdate(fn: (platform: PlatformId, id: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Markets with a quote newer than maxAgeMs, per platform. */
  freshCount(platform: PlatformId, maxAgeMs: number, now = Date.now()): number {
    let n = 0;
    for (const [k, q] of this.quotes) if (k.startsWith(`${platform}:`) && now - q.at <= maxAgeMs) n++;
    return n;
  }
}

/** A streamed price is only a price if it's strictly inside (0, 1). */
export function streamPrice(v: unknown): number | undefined {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1 ? n : undefined;
}

/**
 * Overlay a streamed quote on a market snapshot. Quotes are dropped whenever their stream
 * disconnects, so one in the book is current (streams send on every change); maxAgeMs is only a
 * backstop. A streamed empty book stays empty (untradeable) rather than falling back to old REST
 * prices. Only open markets are touched: status, resolution, liquidity and volume stay REST data.
 * `quotedAt` marks a market whose bid/ask came from the stream; fast checks act only on those.
 */
export function withLiveQuote(m: NormalizedMarket, q: LiveQuote | undefined, maxAgeMs: number, now = Date.now()): NormalizedMarket {
  if (!q || (m.status ?? "open") !== "open" || now - q.at > maxAgeMs) return m;
  if (q.bid == null && q.ask == null) {
    return { ...m, yesBid: undefined, yesAsk: undefined, quotedAt: new Date(q.at).toISOString() };
  }
  const bid = q.bid;
  const ask = q.ask;
  const yes = bid != null && ask != null ? (bid + ask) / 2 : (q.last ?? bid ?? ask ?? m.yesPrice);
  return {
    ...m,
    yesBid: bid,
    yesAsk: ask,
    yesPrice: yes,
    noPrice: 1 - yes,
    lastPrice: q.last ?? m.lastPrice,
    quotedAt: new Date(q.at).toISOString(),
  };
}
