#!/usr/bin/env node
import { parseArgs, buildEmit } from "./args.js";
import { runScan } from "../engine/runner.js";
import { recordPaperFill } from "../ledger/paper.js";

async function main() {
  const args = parseArgs(process.argv);
  const emit = await buildEmit(args);

  await runScan({
    rulesPath: args.rules,
    demo: args.demo,
    limitPerPlatform: args.limit,
    mode: "paper",
    emit,
    onSignal: async ({ rule, market, side, sizeUsd }) => {
      const fill = await recordPaperFill({
        ruleId: rule.id,
        platform: market.platform,
        marketId: market.id,
        title: market.title,
        side,
        price: side === "yes" ? market.yesPrice : (market.noPrice ?? 1 - market.yesPrice),
        sizeUsd,
      });
      await emit({
        at: fill.at,
        type: "paper_fill",
        ruleId: rule.id,
        message: `Paper fill recorded ${fill.id} (${side} @ ${fill.price.toFixed(3)}, $${sizeUsd.toFixed(2)})`,
        market: {
          platform: market.platform,
          id: market.id,
          title: market.title,
          yesPrice: market.yesPrice,
          url: market.url,
        },
        side,
        sizeUsd,
        data: { fillId: fill.id, ledger: "data/paper-ledger.json" },
      });
    },
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
