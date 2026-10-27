#!/usr/bin/env node
/**
 * Manually close a paper position at a price you supply — for markets that can't
 * settle on their own (voided, split or scalar payouts the adapter can't read,
 * markets that vanished). Offline: no network, no orders. Does not change the
 * rule's consecutive-loss streak.
 */
import { parseArgs } from "./args.js";
import {
  closePosition,
  defaultLedgerPath,
  loadLedger,
  saveLedger,
  withLedgerLock,
} from "../ledger/paper.js";

async function main() {
  const args = parseArgs(process.argv);
  if (!args.id || args.price == null) {
    console.error("Usage: npm run paper:close -- --id <position id> --price <0-1> [--demo] [--ledger path]");
    process.exit(2);
  }
  const ledgerPath = args.ledger ?? defaultLedgerPath(args.demo);
  await withLedgerLock(ledgerPath, async () => {
    const ledger = await loadLedger(ledgerPath, { demo: args.demo });
    const matches = ledger.positions.filter((p) => p.status === "open" && p.id.startsWith(args.id!));
    if (matches.length !== 1) {
      throw new Error(
        matches.length === 0
          ? `No open position with id starting "${args.id}" in ${ledgerPath}`
          : `"${args.id}" matches ${matches.length} open positions; use more of the id`,
      );
    }
    const pos = matches[0];
    const pnl = closePosition(ledger, pos, {
      price: args.price!,
      at: new Date(),
      reason: "manual",
      detail: "closed with npm run paper:close",
    });
    await saveLedger(ledgerPath, ledger);
    console.log(
      `Closed ${pos.ruleId} ${pos.platform}:${pos.marketId} ${pos.side.toUpperCase()} ` +
        `${pos.entryPrice.toFixed(3)} → ${args.price!.toFixed(3)} PnL ${pnl < 0 ? "-" : ""}$${Math.abs(pnl).toFixed(2)}`,
    );
  });
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
