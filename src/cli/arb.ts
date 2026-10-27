#!/usr/bin/env node
/**
 * Review cross-platform pairs for the arbitrage strategy. Read-only market data;
 * confirm / block only edit rules/arb-pairs.yaml. Never places orders.
 *
 *   npm run arb:find                 list likely pairs (numbered) with today's edge
 *   npm run arb:confirm -- 3         always treat pair #3 as the same question
 *   npm run arb:confirm -- 3 --invert   …where Polymarket YES = Kalshi NO
 *   npm run arb:block -- 3           never trade pair #3
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isSeq, parseDocument, YAMLSeq } from "yaml";
import { parseArgs } from "./args.js";
import { loadRulesFile } from "../rules/loader.js";
import { ArbitrageSchema } from "../rules/schema.js";
import { createAdapters } from "../platforms/index.js";
import { fetchMarkets } from "../engine/runner.js";
import { findMatches } from "../engine/match.js";
import { crossBaskets, discoverBaskets, bestQuotes, loadPairsFile, pairKey, pairsFilePath, quoteBasket } from "../engine/arb.js";
import { quoteEnv } from "../engine/arb-runtime.js";
import { positionSizeUsd } from "../engine/risk.js";
import { arbitrageAsRule } from "../rules/schema.js";
import type { EventGroup } from "../platforms/types.js";

interface Saved {
  n: number;
  kalshi: { id: string; title: string };
  polymarket: { id: string; title: string };
}

const candidatesPath = (demo: boolean) => path.resolve(demo ? "data/arb-candidates.demo.json" : "data/arb-candidates.json");
const cents = (p?: number) => (p == null ? "—" : `${(p * 100).toFixed(1).replace(/\.0$/, "")}¢`);

async function find() {
  const args = parseArgs(process.argv);
  const file = await loadRulesFile(args.rules);
  const cfg = file.arbitrage ?? ArbitrageSchema.parse({});
  const adapters = createAdapters({ demo: args.demo, platforms: ["kalshi", "polymarket"], fixturePath: args.fixture });
  const now = new Date();
  const { markets: listed } = await fetchMarkets(adapters, cfg.cross_platform.scan_limit, async (e) => {
    if (e.type === "adapter_error") console.error(`⚠ ${e.message}`);
  });
  // Kalshi's real questions live in its events list; read a few pages (politely — it rate-limits).
  const pagesEnv = Number(process.env.ARB_FIND_PAGES);
  const pages = Number.isInteger(pagesEnv) && pagesEnv > 0 ? Math.min(pagesEnv, 20) : args.all ? 6 : 3;
  const groups: EventGroup[] = [];
  for (const a of adapters) {
    try {
      if (a.listEventGroupsPage) {
        let cursor: string | undefined;
        for (let i = 0; i < pages; i++) {
          const page = await a.listEventGroupsPage({ limit: 200, cursor });
          groups.push(...page.groups);
          cursor = page.cursor;
          if (!cursor) break;
          await new Promise((r) => setTimeout(r, 1500));
        }
      } else if (a.listEventGroups) {
        groups.push(...(await a.listEventGroups({ limit: cfg.same_platform.scan_events })));
      }
    } catch (err) {
      console.error(`⚠ ${a.id}: ${(err as Error).message}`);
    }
  }
  const byKey = new Map<string, (typeof listed)[number]>();
  for (const m of [...listed, ...groups.flatMap((g) => g.markets)]) if (!byKey.has(`${m.platform}:${m.id}`)) byKey.set(`${m.platform}:${m.id}`, m);
  const markets = [...byKey.values()];
  const pairsPath = pairsFilePath(args.rules, cfg);
  const pairs = await loadPairsFile(pairsPath);
  const confirmed = new Map(pairs.confirmed.map((c) => [pairKey(c.kalshi, c.polymarket), c]));
  const blocked = new Set(pairs.blocked.map((b) => pairKey(b.kalshi, b.polymarket)));
  const env = quoteEnv(cfg, adapters, now);
  const size = positionSizeUsd(arbitrageAsRule(cfg).risk);

  const kal = markets.filter((m) => m.platform === "kalshi");
  const poly = markets.filter((m) => m.platform === "polymarket");
  console.log(`\nScanned ${kal.length} Kalshi and ${poly.length} Polymarket markets (${groups.length} events)${args.demo ? " [DEMO]" : ""}.\n`);

  const cands = findMatches(kal, poly, {
    minScore: cfg.cross_platform.min_score,
    maxCloseGapHours: cfg.cross_platform.max_close_gap_hours,
    includeRejected: true,
    reviewFloor: args.all ? 0.25 : 0.4,
    exclude: new Set(pairs.blocked.map((b) => `${b.kalshi}|${b.polymarket}`)),
  });
  const rank = (c: (typeof cands)[number]) => {
    const key = pairKey(c.kalshi.id, c.polymarket.id);
    return confirmed.has(key) ? 0 : blocked.has(key) ? 3 : c.ok ? 1 : 2;
  };
  cands.sort((a, b) => rank(a) - rank(b) || b.score - a.score);

  const saved: Saved[] = [];
  if (!cands.length) console.log("No likely pairs found. Try --all to see weaker look-alikes.\n");
  for (const c of cands.slice(0, 60)) {
    const key = pairKey(c.kalshi.id, c.polymarket.id);
    const gap = Math.abs(c.kalshi.yesPrice - c.polymarket.yesPrice);
    const status = confirmed.has(key)
      ? "CONFIRMED — trades"
      : blocked.has(key)
        ? "BLOCKED"
        : c.ok && gap <= cfg.cross_platform.max_price_gap
          ? !cfg.cross_platform.auto_match
            ? "AUTO match (auto_match is off)"
            : cfg.cross_platform.auto_trade
              ? "AUTO — trades (check it!)"
              : "AUTO — alerts only; confirm it to paper-trade"
          : c.ok
            ? `SKIPPED — prices ${Math.round(gap * 100)}¢ apart`
            : `not matched — ${c.reason}`;
    const invert = confirmed.get(key)?.invert ?? false;
    const baskets = crossBaskets(c.kalshi, c.polymarket, invert, "confirmed");
    const quotes = baskets
      .map((b) => quoteBasket(b, { sizeUsd: size }, env))
      .filter((q): q is NonNullable<typeof q> => q != null)
      .sort((a, b) => b.edge - a.edge);
    const best = quotes[0];
    // Cheapest cost of a $1 hedge before fees, to show how close a pair is when there's no arb.
    const quotedBoth = c.kalshi.yesBid != null && c.kalshi.yesAsk != null && c.polymarket.yesBid != null && c.polymarket.yesAsk != null;
    const cheapest = quotedBoth
      ? Math.min(...baskets.map((b) => b.legs.reduce((a, l) => a + (l.side === "yes" ? l.market.yesAsk! : 1 - l.market.yesBid!), 0)))
      : undefined;
    const n = saved.length + 1;
    saved.push({ n, kalshi: { id: c.kalshi.id, title: c.kalshi.title }, polymarket: { id: c.polymarket.id, title: c.polymarket.title } });
    console.log(`#${n}  ${status}   similarity ${c.score.toFixed(2)}`);
    console.log(`    Kalshi      ${c.kalshi.title}  [${c.kalshi.id}]  YES ${cents(c.kalshi.yesBid)} / ${cents(c.kalshi.yesAsk)}`);
    console.log(`    Polymarket  ${c.polymarket.title}  [${c.polymarket.id}]  YES ${cents(c.polymarket.yesBid)} / ${cents(c.polymarket.yesAsk)}`);
    console.log(
      best
        ? `    Arb now: ${best.edge > 0 ? "+" : ""}${(best.edge * 100).toFixed(1)}¢ per $1 after fees` +
            ` (${best.legs.map((l) => `${l.side.toUpperCase()} ${l.market.platform}`).join(" + ")})` +
            (best.edge >= cfg.min_edge ? "  ← above your min_edge" : "")
        : cheapest != null
          ? `    Arb now: none — a $1 hedge costs ${(cheapest * 100).toFixed(1)}¢ before fees`
          : "    Arb now: none (one side has no bid or ask)",
    );
    console.log("");
  }

  // Same-site arbitrage summary.
  if (cfg.same_platform.enabled) {
    const d = await discoverBaskets({ cfg: { ...cfg, cross_platform: { ...cfg.cross_platform, enabled: false } }, pairs, markets: [], eventGroups: groups });
    const qs = bestQuotes(d.baskets, size, env).filter((q) => q.edge >= cfg.min_edge);
    console.log(`Same-site: ${groups.filter((g) => g.mutuallyExclusive).length} events where only one outcome can win; ${qs.length} with an arb ≥ ${(cfg.min_edge * 100).toFixed(1)}¢ per $1.`);
    for (const q of qs.slice(0, 10)) console.log(`    +${(q.edge * 100).toFixed(1)}¢  ${q.basket.title}`);
    console.log("");
  }

  await mkdir(path.dirname(candidatesPath(args.demo)), { recursive: true });
  await writeFile(candidatesPath(args.demo), JSON.stringify(saved, null, 2));
  console.log(`Pairs file: ${pairsPath}`);
  console.log("Same question?   npm run arb:confirm -- <#>      (add --invert if Polymarket YES = Kalshi NO)");
  console.log("Different?       npm run arb:block -- <#>");
}

async function edit(kind: "confirmed" | "blocked") {
  const args = parseArgs(process.argv);
  const n = Number(args.positional.find((x) => /^\d+$/.test(x)));
  if (!Number.isInteger(n) || n < 1) {
    console.error(`Usage: npm run arb:${kind === "confirmed" ? "confirm" : "block"} -- <number from arb:find>${kind === "confirmed" ? " [--invert]" : ""}`);
    process.exit(2);
  }
  let saved: Saved[];
  try {
    saved = JSON.parse(await readFile(candidatesPath(args.demo), "utf8"));
  } catch {
    console.error(`Run npm run arb:find${args.demo ? " -- --demo" : ""} first.`);
    process.exit(2);
  }
  const pick = saved.find((s) => s.n === n);
  if (!pick) {
    console.error(`No pair #${n} in the last arb:find (it listed ${saved.length}).`);
    process.exit(2);
  }
  const file = await loadRulesFile(args.rules);
  const cfg = file.arbitrage ?? ArbitrageSchema.parse({});
  const pairsPath = pairsFilePath(args.rules, cfg);
  const raw = await readFile(pairsPath, "utf8").catch(() => "confirmed: []\nblocked: []\n");
  const doc = parseDocument(raw);
  const same = (item: unknown) => {
    const j = (item as { toJSON?: () => unknown })?.toJSON?.() as { kalshi?: string; polymarket?: string } | undefined;
    return j?.kalshi === pick.kalshi.id && String(j?.polymarket) === pick.polymarket.id;
  };
  for (const list of ["confirmed", "blocked"] as const) {
    let seq = doc.get(list, true);
    if (!isSeq(seq)) {
      seq = new YAMLSeq();
      doc.set(list, seq);
    }
    const s = seq as YAMLSeq;
    s.items = s.items.filter((it) => !same(it));
    if (list === kind) {
      s.flow = false;
      s.add(
        doc.createNode({
          kalshi: pick.kalshi.id,
          polymarket: pick.polymarket.id,
          ...(kind === "confirmed" && args.invert ? { invert: true } : {}),
          note: `${pick.kalshi.title} ↔ ${pick.polymarket.title}`.slice(0, 160),
        }),
      );
    }
  }
  await writeFile(pairsPath, doc.toString());
  await loadPairsFile(pairsPath); // validate what we wrote
  console.log(`${kind === "confirmed" ? "Confirmed" : "Blocked"} #${n}: ${pick.kalshi.title} ↔ ${pick.polymarket.title}`);
  console.log(`Saved to ${pairsPath}`);
}

const cmd = process.argv[2];
const run = cmd === "find" ? find() : cmd === "confirm" ? edit("confirmed") : cmd === "block" ? edit("blocked") : Promise.reject(new Error("usage: arb.ts find|confirm|block"));
run.catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
