#!/usr/bin/env node
/**
 * npm run paper:reset -- --yes [--demo] [--ledger path]
 * Start the paper portfolio over at $0. The current ledger is copied to data/archive/ first and
 * never deleted. Offline: no network, no orders. (The dashboard's Reset button does the same at
 * the bot's next check.)
 */
import { parseArgs } from "./args.js";
import { defaultLedgerPath, loadLedger, resetLedger, summarizeLedger, withLedgerLock } from "../ledger/paper.js";

async function main() {
  const args = parseArgs(process.argv);
  const ledgerPath = args.ledger ?? defaultLedgerPath(args.demo);
  const money = (n: number) => `${n < 0 ? "-" : n > 0 ? "+" : ""}$${Math.abs(n).toFixed(2)}`;
  if (!args.yes) {
    const t = summarizeLedger(await loadLedger(ledgerPath, { demo: args.demo })).total;
    console.log(`This starts the paper portfolio over at $0: ${ledgerPath}`);
    console.log(`  now: ${money(t.realizedPnlUsd + t.unrealizedPnlUsd)} from ${t.closed} closed and ${t.open} open paper trade(s)`);
    console.log("  The current file is copied to data/archive/ first. Open paper trades are dropped; strategies and their switches stay.");
    console.log("Run it again with --yes to go ahead:  npm run paper:reset -- --yes");
    return;
  }
  await withLedgerLock(ledgerPath, async () => {
    const r = await resetLedger(ledgerPath, { demo: args.demo });
    console.log(`Paper portfolio reset. It ended at ${money(r.pnlUsd)} (${r.closed} closed, ${r.open} open).`);
    console.log(r.archive ? `Saved the old trades to ${r.archive} (next to the ledger).` : "There were no trades to save.");
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
