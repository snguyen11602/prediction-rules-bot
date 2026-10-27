#!/usr/bin/env node
/**
 * Paper trading: hypothetical fills, marks, exits and PnL in a local JSON ledger.
 * Never places orders — see src/cli/live.ts for the (stubbed) live gate.
 */
import { parseArgs, buildEmit } from "./args.js";
import { runPaperCycle } from "../engine/paper-session.js";
import { defaultLedgerPath } from "../ledger/paper.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const emit = await buildEmit(args);
  const ledgerPath = args.ledger ?? defaultLedgerPath(args.demo);

  const cycle = () =>
    runPaperCycle({
      rulesPath: args.rules,
      ledgerPath,
      demo: args.demo,
      fixturePath: args.fixture,
      limitPerPlatform: args.limit,
      paperAll: args.paperAll,
      emit,
    });

  if (!args.loop) {
    await cycle();
    return;
  }

  // eslint-disable-next-line no-console
  console.log(`Paper loop every ${args.intervalSec}s → ${ledgerPath} (Ctrl+C to stop)${args.demo ? " [DEMO]" : ""}`);
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      // Keep looping on transient failures (e.g. a lock held by a cron run).
      console.error(`Paper cycle failed: ${(err as Error).message}`);
    }
    await sleep(Math.max(5, args.intervalSec) * 1000);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
