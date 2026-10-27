#!/usr/bin/env node
import { parseArgs, buildEmit } from "./args.js";
import { runScan } from "../engine/runner.js";

async function main() {
  const args = parseArgs(process.argv);
  const emit = await buildEmit(args);
  await runScan({
    rulesPath: args.rules,
    demo: args.demo,
    limitPerPlatform: args.limit,
    mode: "alert",
    emit,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
