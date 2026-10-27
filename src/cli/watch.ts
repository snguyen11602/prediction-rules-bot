#!/usr/bin/env node
import { parseArgs, buildEmit } from "./args.js";
import { runScan } from "../engine/runner.js";
import type { PriorPrice } from "../engine/evaluate.js";
import type { RiskState } from "../engine/risk.js";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  const args = parseArgs(process.argv);
  const emit = await buildEmit(args);
  const priceHistory = new Map<string, PriorPrice>();
  const riskByRule = new Map<string, RiskState>();

  // eslint-disable-next-line no-console
  console.log(`Watching every ${args.intervalSec}s (Ctrl+C to stop)${args.demo ? " [DEMO]" : ""}`);

  for (;;) {
    await runScan({
      rulesPath: args.rules,
      demo: args.demo,
      limitPerPlatform: args.limit,
      mode: "alert",
      emit,
      priceHistory,
      riskByRule,
    });
    await sleep(Math.max(5, args.intervalSec) * 1000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
