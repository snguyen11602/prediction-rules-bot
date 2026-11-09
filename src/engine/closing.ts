import type { PaperLedger, PaperPosition } from "../ledger/paper.js";
import type { PlatformAdapter } from "../platforms/types.js";
import type { NormalizedMarket, PlatformId } from "../types.js";
import { isGame } from "./games.js";

/**
 * Closing-price tracking. For a bet placed before a game, the price just before the start (the
 * "closing price") is the market's best guess with everything known. Paying less than the close,
 * trade after trade, is the quickest sign a strategy has a real edge: it shows in dozens of trades,
 * where profit and loss needs hundreds. `closing.price − entryPrice` > 0 means the bet beat the close.
 */

/** A check this close to the start counts as the closing price. */
const FRESH_MIN = 15;
/** Without anything better, a check up to this old is still used. */
const STALE_MIN = 90;
const MAX_SPREAD = 0.1;
const H = 3600_000;

const heldMid = (yesMid: number, side: PaperPosition["side"]) => (side === "yes" ? yesMid : 1 - yesMid);

/** At entry: remember when the game starts (pre-game bets on games only). */
export function startTracking(pos: PaperPosition, market: NormalizedMarket, now: Date): void {
  const start = market.startsAt ? Date.parse(market.startsAt) : NaN;
  if (!isGame(market) || !Number.isFinite(start) || start <= now.getTime()) return;
  pos.startsAt = new Date(start).toISOString();
}

/** Each check before the start: keep the latest trustworthy mid as the closing price so far. */
export function noteClosing(pos: PaperPosition, market: NormalizedMarket, now: Date): void {
  if (!pos.startsAt || pos.closing?.final || now.getTime() >= Date.parse(pos.startsAt)) return;
  if (market.yesBid == null || market.yesAsk == null || !(market.yesBid > 0) || !(market.yesAsk < 1) || market.yesAsk - market.yesBid > MAX_SPREAD + 1e-9) return;
  pos.closing = { price: heldMid((market.yesBid + market.yesAsk) / 2, pos.side), at: now.toISOString(), source: "check" };
}

/**
 * After the start: settle each tracked bet's closing price. A check within 15 minutes of the start
 * wins; otherwise the platform's last hourly price before the start (so a sleeping laptop still gets
 * one); otherwise an older check; otherwise it's marked as missed after six hours.
 */
export async function finalizeClosings(ledger: PaperLedger, adapterFor: (id: PlatformId) => PlatformAdapter | undefined, now: Date): Promise<number> {
  const nowMs = now.getTime();
  let done = 0;
  const need = new Map<PlatformId, PaperPosition[]>();
  for (const pos of ledger.positions) {
    if (!pos.startsAt || pos.groupId || pos.closing?.final || pos.closingMissed) continue;
    const start = Date.parse(pos.startsAt);
    if (!(start <= nowMs)) continue;
    if (pos.closing && start - Date.parse(pos.closing.at) <= FRESH_MIN * 60_000) {
      pos.closing.final = true;
      done++;
    } else if (nowMs - start > 15 * 24 * H) {
      pos.closingMissed = true;
    } else {
      need.set(pos.platform, [...(need.get(pos.platform) ?? []), pos]);
    }
  }
  for (const [platform, all] of need) {
    const adapter = adapterFor(platform);
    // One request per day of starts, so a backlog never asks for weeks of hourly prices at once.
    const sorted = [...all].sort((a, b) => Date.parse(a.startsAt!) - Date.parse(b.startsAt!));
    const batches: PaperPosition[][] = [];
    for (const p of sorted) {
      const last = batches.at(-1);
      if (last && Date.parse(p.startsAt!) - Date.parse(last[0].startsAt!) <= 24 * H) last.push(p);
      else batches.push([p]);
    }
    for (const list of batches) {
      let hist: Awaited<ReturnType<NonNullable<PlatformAdapter["priceHistory"]>>> | undefined;
      if (adapter?.priceHistory) {
        const starts = list.map((p) => Date.parse(p.startsAt!));
        try {
          hist = await adapter.priceHistory([...new Set(list.map((p) => p.marketId))], Math.min(...starts) - 3 * H, Math.max(...starts));
        } catch {
          hist = undefined; // try again next check
        }
      }
      for (const pos of list) {
        const start = Date.parse(pos.startsAt!);
        const tick = (hist?.get(pos.marketId) ?? []).filter((t) => t.t <= start && t.t >= start - 2 * H && (t.s == null || t.s <= MAX_SPREAD + 1e-9)).at(-1);
        if (tick) {
          pos.closing = { price: heldMid(tick.p, pos.side), at: new Date(tick.t).toISOString(), source: "hourly", final: true };
          done++;
        } else if (pos.closing && start - Date.parse(pos.closing.at) <= STALE_MIN * 60_000 && (hist || !adapter?.priceHistory)) {
          pos.closing.final = true;
          done++;
        } else if (nowMs - start > 6 * H && (hist || !adapter?.priceHistory)) {
          // Looked and found nothing (a failed lookup is retried instead).
          pos.closingMissed = true;
        }
      }
    }
  }
  return done;
}

/** One-time: start tracking recent Kalshi game bets made before this feature existed. */
export async function backfillStarts(ledger: PaperLedger, adapterFor: (id: PlatformId) => PlatformAdapter | undefined, now: Date): Promise<void> {
  const todo = ledger.positions.filter(
    (p) => !p.startsAt && !p.closingMissed && !p.groupId && now.getTime() - Date.parse(p.entryAt) < 14 * 24 * H && isGame({ platform: p.platform, id: p.marketId }),
  );
  if (!todo.length) return;
  const byPlatform = new Map<PlatformId, PaperPosition[]>();
  for (const p of todo) byPlatform.set(p.platform, [...(byPlatform.get(p.platform) ?? []), p]);
  for (const [platform, list] of byPlatform) {
    const adapter = adapterFor(platform);
    if (!adapter?.getMarkets || !adapter.priceHistory) {
      for (const p of list) p.closingMissed = true;
      continue;
    }
    let markets: NormalizedMarket[];
    try {
      markets = await adapter.getMarkets([...new Set(list.map((p) => p.marketId))]);
    } catch {
      continue; // try again next check
    }
    const byId = new Map(markets.map((m) => [m.id, m]));
    for (const p of list) {
      const start = Date.parse(byId.get(p.marketId)?.startsAt ?? "");
      if (Number.isFinite(start) && Date.parse(p.entryAt) < start) p.startsAt = new Date(start).toISOString();
      else p.closingMissed = true; // in-play bet, or the market is gone
    }
  }
}

export interface ClosingStats {
  /** Bets with a known closing price. */
  n: number;
  /** Average closing price − price paid (0–1); positive = bought cheaper than the close. */
  avg: number;
  /** How many beat the close. */
  beat: number;
}

export function closingStats(positions: PaperPosition[]): ClosingStats {
  const xs = positions.filter((p) => p.closing?.final && !p.groupId).map((p) => p.closing!.price - p.entryPrice);
  return { n: xs.length, avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0, beat: xs.filter((x) => x > 1e-9).length };
}

/** "+1.2¢ vs the close, beat it 18 of 31" (or why there's nothing to say yet). */
export function closingLine(s: ClosingStats | undefined): string {
  if (!s?.n) return "no closing prices yet";
  const c = s.avg * 100;
  return `${c >= 0 ? "+" : "−"}${Math.abs(c).toFixed(1)}¢ vs the close, beat it ${s.beat} of ${s.n}`;
}
