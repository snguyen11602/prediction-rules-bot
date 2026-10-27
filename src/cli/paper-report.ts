#!/usr/bin/env node
/** Offline paper ledger report — no network, no writes. Marks are as of the last paper run. */
import { parseArgs } from "./args.js";
import { defaultLedgerPath, loadLedger, summarizeLedger } from "../ledger/paper.js";

function money(n: number): string {
  return `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;
}

function pad(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);
}

async function main() {
  const args = parseArgs(process.argv);
  const ledgerPath = args.ledger ?? defaultLedgerPath(args.demo);
  const ledger = await loadLedger(ledgerPath, { demo: args.demo });
  const summary = summarizeLedger(ledger);

  if (args.json) {
    console.log(JSON.stringify({ ledger: ledgerPath, ...summary, positions: ledger.positions }, null, 2));
    return;
  }

  console.log(`Paper ledger: ${ledgerPath}${ledger.demo ? " [DEMO]" : ""}\n`);
  const open = ledger.positions.filter((p) => p.status === "open");
  const closed = ledger.positions.filter((p) => p.status === "closed").slice(-20);

  console.log(`OPEN (${open.length})`);
  for (const p of open) {
    console.log(
      `  ${pad(p.ruleId, 26)} ${pad(`${p.platform}:${p.marketId}`, 30)} ${p.side.toUpperCase().padEnd(3)} ` +
        `entry ${p.entryPrice.toFixed(3)} mark ${(p.lastMarkPrice ?? p.entryPrice).toFixed(3)} ` +
        `cost ${money(p.costUsd).padStart(9)} uPnL ${money(p.unrealizedPnlUsd ?? 0).padStart(9)}` +
        (p.marketStatus && p.marketStatus !== "open" ? ` [${p.marketStatus}]` : ""),
    );
  }

  console.log(`\nCLOSED (last ${closed.length})`);
  for (const p of closed) {
    console.log(
      `  ${pad(p.ruleId, 26)} ${pad(`${p.platform}:${p.marketId}`, 30)} ${p.side.toUpperCase().padEnd(3)} ` +
        `${p.entryPrice.toFixed(3)} → ${(p.exitPrice ?? 0).toFixed(3)} ${pad(p.exitReason ?? "", 15)} ` +
        `PnL ${money(p.realizedPnlUsd ?? 0).padStart(9)}`,
    );
  }

  console.log("\nBY RULE");
  for (const s of [...summary.rules, summary.total]) {
    const decided = s.wins + s.losses;
    const winRate = decided ? `${((s.wins / decided) * 100).toFixed(0)}%` : "n/a";
    const paused =
      s.pausedUntil && new Date(s.pausedUntil).getTime() > Date.now() ? ` PAUSED until ${s.pausedUntil}` : "";
    console.log(
      `  ${pad(s.ruleId, 26)} open ${String(s.open).padStart(3)} exp ${money(s.exposureUsd).padStart(10)} ` +
        `uPnL ${money(s.unrealizedPnlUsd).padStart(9)} | closed ${String(s.closed).padStart(3)} ` +
        `${s.wins}W/${s.losses}L (${winRate}) rPnL ${money(s.realizedPnlUsd).padStart(9)} fees ${money(s.feesUsd)}` +
        (s.ruleId !== "TOTAL" ? ` streak ${s.consecutiveLosses}${paused}` : ""),
    );
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
