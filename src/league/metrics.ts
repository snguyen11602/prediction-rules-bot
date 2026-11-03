import type { PaperLedger, PaperPosition } from "../ledger/paper.js";

/** One finished trade, whatever produced it (a position, or a whole arbitrage). */
export interface TradeResult {
  enteredAt: string;
  exitedAt: string;
  pnlUsd: number;
  feesUsd: number;
  reason?: string;
  /** Held-side prices, for diagnostics. */
  entryPrice?: number;
  exitPrice?: number;
  contracts?: number;
}

export interface StrategyStats {
  trades: number;
  wins: number;
  losses: number;
  /** wins / (wins + losses); 0 when nothing finished. */
  winRate: number;
  pnlUsd: number;
  feesUsd: number;
  avgWinUsd: number;
  avgLossUsd: number;
  /** Largest fall from a high point of cumulative P/L (USD, positive). */
  maxDrawdownUsd: number;
  /** Return on the bankroll in %, minus the largest drop in % — rewards steady profit. */
  steadyScore: number;
  returnPct: number;
  avgHoldHours: number;
  exits: Record<string, number>;
  open: number;
  openPnlUsd: number;
  /** Enough finished trades to rank. */
  ranked: boolean;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

export function statsFromTrades(trades: TradeResult[], opts: { bankrollUsd: number; minTrades: number; open?: number; openPnlUsd?: number }): StrategyStats {
  const sorted = [...trades].sort((a, b) => a.exitedAt.localeCompare(b.exitedAt));
  let cum = 0;
  let peak = 0;
  let dd = 0;
  for (const t of sorted) {
    cum += t.pnlUsd;
    peak = Math.max(peak, cum);
    dd = Math.max(dd, peak - cum);
  }
  const wins = sorted.filter((t) => t.pnlUsd > 0.005);
  const losses = sorted.filter((t) => t.pnlUsd < -0.005);
  const exits: Record<string, number> = {};
  for (const t of sorted) exits[t.reason ?? "other"] = (exits[t.reason ?? "other"] ?? 0) + 1;
  const holds = sorted.map((t) => (Date.parse(t.exitedAt) - Date.parse(t.enteredAt)) / 3600_000).filter((h) => Number.isFinite(h) && h >= 0);
  const bank = Math.max(1, opts.bankrollUsd);
  const returnPct = (cum / bank) * 100;
  return {
    trades: sorted.length,
    wins: wins.length,
    losses: losses.length,
    winRate: wins.length + losses.length ? wins.length / (wins.length + losses.length) : 0,
    pnlUsd: r2(cum),
    feesUsd: r2(sorted.reduce((a, t) => a + t.feesUsd, 0)),
    avgWinUsd: wins.length ? r2(wins.reduce((a, t) => a + t.pnlUsd, 0) / wins.length) : 0,
    avgLossUsd: losses.length ? r2(losses.reduce((a, t) => a + t.pnlUsd, 0) / losses.length) : 0,
    maxDrawdownUsd: r2(dd),
    steadyScore: Math.round((returnPct - (dd / bank) * 100) * 100) / 100,
    returnPct: Math.round(returnPct * 100) / 100,
    avgHoldHours: holds.length ? Math.round((holds.reduce((a, b) => a + b, 0) / holds.length) * 10) / 10 : 0,
    exits,
    open: opts.open ?? 0,
    openPnlUsd: r2(opts.openPnlUsd ?? 0),
    ranked: sorted.length >= opts.minTrades,
  };
}

export function positionTrade(p: PaperPosition): TradeResult | null {
  if (p.status !== "closed" || !p.exitAt) return null;
  return {
    enteredAt: p.entryAt,
    exitedAt: p.exitAt,
    pnlUsd: p.realizedPnlUsd ?? 0,
    feesUsd: p.entryFeeUsd + (p.exitFeeUsd ?? 0),
    reason: p.exitReason,
    entryPrice: p.entryPrice,
    exitPrice: p.exitPrice,
    contracts: p.contracts,
  };
}

/** Finished trades per strategy in a ledger (an arbitrage counts once, when its last leg settles). */
export function tradesByRule(ledger: PaperLedger): Map<string, TradeResult[]> {
  const out = new Map<string, TradeResult[]>();
  const add = (id: string, t: TradeResult) => out.set(id, [...(out.get(id) ?? []), t]);
  for (const p of ledger.positions) {
    if (p.groupId) continue;
    const t = positionTrade(p);
    if (t) add(p.ruleId, t);
  }
  for (const g of Object.values(ledger.arbGroups ?? {})) {
    if (g.status !== "closed" || !g.closedAt) continue;
    const legs = ledger.positions.filter((p) => p.groupId === g.id);
    add(g.ruleId, {
      enteredAt: g.openedAt,
      exitedAt: g.closedAt,
      pnlUsd: g.realizedPnlUsd ?? 0,
      feesUsd: legs.reduce((a, p) => a + p.entryFeeUsd + (p.exitFeeUsd ?? 0), 0),
      reason: g.closeReason,
    });
  }
  return out;
}

export function openByRule(ledger: PaperLedger): Map<string, { open: number; pnl: number }> {
  const out = new Map<string, { open: number; pnl: number }>();
  for (const p of ledger.positions) {
    if (p.status !== "open" || p.groupId) continue;
    const cur = out.get(p.ruleId) ?? { open: 0, pnl: 0 };
    cur.open += 1;
    cur.pnl += p.unrealizedPnlUsd ?? 0;
    out.set(p.ruleId, cur);
  }
  return out;
}
