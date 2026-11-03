import type { Rule } from "../rules/schema.js";
import type { StrategyStats } from "./metrics.js";

/** Plain-English "why didn't this work", from a strategy's trades and the checks that stopped it. */
export interface Diagnosis {
  at: string;
  headline: string;
  findings: string[];
  suggestion: string;
}

/** What blocked it, summed over a backtest or paper run: check name → times it was the first to fail. */
export interface BlockCounts {
  checks: number;
  signals: number;
  blocked: Record<string, number>;
}

const usd = (n: number) => `${n < 0 ? "−" : ""}$${Math.abs(n).toFixed(2)}`;
const pct = (n: number) => `${Math.round(n * 100)}%`;

const LOOSEN: Record<string, string> = {
  "Price band": "widen its price range",
  "Price move": "react to smaller moves",
  Spread: "accept a slightly wider bid/ask gap",
  "Time to resolve": "widen its time-to-resolve window",
  Topic: "look at more topics",
  "Excluded words": "exclude fewer words",
  Liquidity: "accept thinner markets",
  "24h volume": "accept quieter markets",
  "YES at least": "lower its entry level",
  "YES at most": "raise its entry level",
};

export function diagnose(
  s: StrategyStats,
  opts: { minTrades: number; blocks?: BlockCounts; test?: StrategyStats; now?: Date; rule?: Pick<Rule, "exit" | "risk"> },
): Diagnosis {
  const at = (opts.now ?? new Date()).toISOString();
  const findings: Array<{ weight: number; text: string; fix: string }> = [];
  const b = opts.blocks;

  if (s.trades === 0 && s.open === 0) {
    const [top, n] = Object.entries(b?.blocked ?? {}).sort((x, y) => y[1] - x[1])[0] ?? [];
    if (b && b.signals > 0) {
      findings.push({ weight: 10, text: `It found ${b.signals} signal(s) but never got a trade in — ${top ? `"${top}" stopped them` : "the risk limits stopped them"}.`, fix: "loosen its risk limits or cool-down" });
    } else if (top && b) {
      findings.push({
        weight: 10,
        text: `Never found a trade: "${top}" ruled out ${pct(n! / Math.max(1, b.checks))} of the ${b.checks.toLocaleString("en-US")} market checks.`,
        fix: LOOSEN[top] ?? `loosen "${top}"`,
      });
    } else {
      findings.push({ weight: 10, text: "Never found a trade.", fix: "loosen its filters" });
    }
  } else if (s.trades < opts.minTrades) {
    findings.push({ weight: 4, text: `Only ${s.trades} finished trade(s) — too few to judge.`, fix: "loosen its filters so it trades more" });
  }

  if (s.open > 0 && s.openPnlUsd < 0 && Math.abs(s.openPnlUsd) >= Math.max(5, Math.abs(s.realizedPnlUsd) * 0.5)) {
    findings.push({
      weight: 7,
      text: `Still holding ${s.open} trade(s) worth ${usd(s.openPnlUsd)} at the end — it lets losers ride instead of selling them.`,
      fix: "add a stop loss or a time limit",
    });
  }

  // The rule's own numbers: a target that can't beat costs, or one smaller than the stop.
  const x = opts.rule?.exit;
  const traded = s.trades + s.open;
  if (x?.take_profit_pct != null && traded > 0 && s.pnlUsd < 0) {
    const stake = Math.min(opts.rule!.risk.max_position_usd ?? Infinity, opts.rule!.risk.bankroll_usd * opts.rule!.risk.position_size_fraction);
    const costPct = stake > 0 ? s.feesUsd / traded / stake : 0;
    if (costPct > 0 && x.take_profit_pct < 3 * costPct) {
      findings.push({
        weight: 8,
        text: `Its profit target (+${Math.round(x.take_profit_pct * 100)}%) is tiny next to its costs: fees alone take about ${(costPct * 100).toFixed(1)}% of each trade, before the bid/ask gap.`,
        fix: "aim for bigger moves (a target several times the costs)",
      });
    }
    if (x.stop_loss_pct != null && x.take_profit_pct < x.stop_loss_pct) {
      const need = Math.round((x.stop_loss_pct / (x.stop_loss_pct + x.take_profit_pct)) * 100);
      findings.push({
        weight: 7,
        text: `It aims to win +${Math.round(x.take_profit_pct * 100)}% but risks −${Math.round(x.stop_loss_pct * 100)}%, so it must be right about ${need}% of the time just to break even.`,
        fix: "make the profit target at least twice the stop",
      });
    }
  }

  const gross = s.pnlUsd + s.feesUsd;
  if (s.trades > 0 && s.pnlUsd < 0 && s.feesUsd > 0 && s.feesUsd >= Math.abs(s.pnlUsd) * 0.5) {
    findings.push({
      weight: 8,
      text: `Fees ate the edge: ${usd(s.feesUsd)} in fees, ${gross >= 0 ? `against ${usd(gross)} made before fees` : `on top of ${usd(gross)} lost before fees`}.`,
      fix: "aim for bigger moves per trade, or trade less often",
    });
  }
  if (s.wins >= 3 && s.losses >= 1 && s.winRate >= 0.55 && Math.abs(s.avgLossUsd) > 2 * s.avgWinUsd) {
    findings.push({
      weight: 7,
      text: `Wins small, loses big: ${pct(s.winRate)} of trades win, but the average win is ${usd(s.avgWinUsd)} and the average loss ${usd(s.avgLossUsd)}.`,
      fix: "use a tighter stop loss or take less risk per trade",
    });
  }
  if (s.trades >= 4 && s.winRate < 0.35) {
    findings.push({ weight: 6, text: `Wrong more often than right: only ${pct(s.winRate)} of trades made money.`, fix: "wait for stronger signals before buying" });
  }
  const share = (k: string) => (s.trades ? (s.exits[k] ?? 0) / s.trades : 0);
  if (s.trades >= 4 && share("stop_loss") >= 0.5) {
    findings.push({ weight: 6, text: `Stopped out on ${pct(share("stop_loss"))} of trades — its stop may sit inside normal price wiggle.`, fix: "give trades more room (a wider stop)" });
  }
  if (s.trades >= 4 && share("max_hold") >= 0.5) {
    findings.push({ weight: 5, text: `Ran out of time on ${pct(share("max_hold"))} of trades — the move it waits for usually didn't come.`, fix: "hold longer or pick bigger moves" });
  }
  if (s.trades >= 4 && share("trailing_stop") >= 0.6 && s.pnlUsd < 0) {
    findings.push({ weight: 5, text: `Its trailing stop sold ${pct(share("trailing_stop"))} of trades before they paid.`, fix: "trail further from the high" });
  }
  if (s.maxDrawdownUsd > 0 && s.maxDrawdownUsd > 2 * Math.abs(s.pnlUsd) && s.trades >= opts.minTrades) {
    findings.push({ weight: 3, text: `Big swings: it fell ${usd(s.maxDrawdownUsd)} from its best point.`, fix: "trade smaller or cap losses sooner" });
  }
  if (opts.test && s.pnlUsd > 0 && opts.test.trades + opts.test.open > 0 && opts.test.pnlUsd < 0) {
    findings.push({
      weight: 9,
      text: `Made ${usd(s.pnlUsd)} overall but lost ${usd(opts.test.pnlUsd)} in the held-out last part — the early gains look like luck or a market that changed.`,
      fix: "don't trust it until it wins on new data",
    });
  }
  if (!findings.length) {
    findings.push(
      s.pnlUsd < 0
        ? { weight: 1, text: `Lost ${usd(s.pnlUsd)} over ${s.trades} trades without one obvious cause.`, fix: "try a different idea" }
        : { weight: 1, text: `Nothing stands out: ${usd(s.pnlUsd)} over ${s.trades} trades.`, fix: "keep watching it" },
    );
  }
  findings.sort((a, b) => b.weight - a.weight);
  return { at, headline: findings[0].text, findings: findings.map((f) => f.text), suggestion: `Next time: ${findings[0].fix}.` };
}
