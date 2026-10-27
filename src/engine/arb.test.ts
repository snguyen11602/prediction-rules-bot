import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ArbitrageSchema } from "../rules/schema.js";
import { kalshiTakerFeeUsd } from "../platforms/kalshi.js";
import { DemoAdapter } from "../platforms/demo.js";
import type { EngineEvent, NormalizedMarket, PlatformId } from "../types.js";
import { bestQuotes, discoverBaskets, pairKey, quoteBasket, unwindProceeds, type QuoteEnv } from "./arb.js";
import { runPaperCycle } from "./paper-session.js";
import { runScan } from "./runner.js";
import type { PaperLedger } from "../ledger/paper.js";
import { readFile } from "node:fs/promises";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const NOW = new Date("2026-10-26T19:00:00Z");
const cfg = ArbitrageSchema.parse({});
const env: QuoteEnv = {
  slippage: 0.005,
  includeFees: true,
  now: NOW,
  feeFor: (pl: PlatformId, c: number, price: number) => (pl === "kalshi" ? kalshiTakerFeeUsd(c, price) : 0),
  roundSets: (pls: PlatformId[], s: number) => (pls.includes("kalshi") ? Math.floor(s) : Math.floor(s * 100) / 100),
};
const closes = new Date(NOW.getTime() + 500 * 3600_000).toISOString();
const mk = (platform: PlatformId, id: string, bid: number, ask: number, over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform,
  id,
  title: id,
  yesPrice: (bid + ask) / 2,
  yesBid: bid,
  yesAsk: ask,
  closesAt: closes,
  ...over,
});

test("cross-platform quote: cheaper direction, whole Kalshi contracts, fees included", async () => {
  const K = mk("kalshi", "K", 0.56, 0.57);
  const P = mk("polymarket", "P", 0.635, 0.645);
  const d = await discoverBaskets({
    cfg,
    pairs: { confirmed: [{ kalshi: "K", polymarket: "P", invert: false }], blocked: [] },
    markets: [K, P],
    eventGroups: [],
  });
  const [q] = bestQuotes(d.baskets, 100, env);
  assert.deepEqual(q.legs.map((l) => `${l.market.platform}:${l.side}`), ["kalshi:yes", "polymarket:no"]);
  assert.equal(q.sets, 105);
  assert.equal(q.costUsd, 99.23); // 105 × (0.575 + 0.370)
  assert.equal(q.feesUsd, 1.8); // Kalshi taker fee on 105 @ 0.575
  assert.equal(q.profitUsd, 3.97);
  assert.ok(q.edge > 0.037 && q.edge < 0.039);
});

test("no arb when costs eat the gap; no arb without real quotes on both sides", () => {
  const basket = (K: NormalizedMarket, P: NormalizedMarket) => ({
    key: "k",
    kind: "cross_platform" as const,
    title: "t",
    legs: [
      { market: K, side: "yes" as const },
      { market: P, side: "no" as const },
    ],
    payoutPerSet: 1,
    matchedBy: "confirmed" as const,
  });
  // 2¢ apart on screen, but after spread, slippage and fees it's not profitable.
  const q = quoteBasket(basket(mk("kalshi", "K", 0.5, 0.51), mk("polymarket", "P", 0.52, 0.53)), { sizeUsd: 100 }, env);
  assert.ok(!q || q.profitUsd <= 0);
  const noBid = mk("polymarket", "P", 0.6, 0.61);
  delete noBid.yesBid;
  assert.equal(quoteBasket(basket(mk("kalshi", "K", 0.5, 0.51), noBid), { sizeUsd: 100 }, env), null);
});

test("same-site baskets: NO basket on exclusive events, YES basket only when one must win", async () => {
  const outcomes = [mk("polymarket", "A", 0.52, 0.53), mk("polymarket", "B", 0.38, 0.39), mk("polymarket", "C", 0.16, 0.17)];
  const group = { platform: "polymarket" as const, eventId: "E", title: "Race", mutuallyExclusive: true, exhaustive: false, markets: outcomes };
  const d = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [group] });
  assert.deepEqual(d.baskets.map((b) => b.kind), ["no_basket"], "YES basket needs an exhaustive event");
  const [q] = bestQuotes(d.baskets, 100, env);
  assert.equal(q.basket.payoutPerSet, 2); // NO on 3 mutually exclusive outcomes: at least 2 pay
  assert.equal(q.profitUsd, 2.3);

  const notExclusive = { ...group, mutuallyExclusive: false };
  const d2 = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [notExclusive] });
  assert.equal(d2.baskets.length, 0, "strike ladders etc. (not exclusive) are never basketed");

  const cheap = [mk("polymarket", "X", 0.29, 0.3), mk("polymarket", "Y", 0.24, 0.25), mk("polymarket", "O", 0.16, 0.17)];
  const exh = { ...group, eventId: "F", markets: cheap, exhaustive: true };
  const d3 = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [], eventGroups: [exh] });
  const yes = bestQuotes(d3.baskets, 100, env).find((x) => x.basket.kind === "yes_basket");
  assert.ok(yes && yes.basket.payoutPerSet === 1 && yes.profitUsd > 0);
});

test("pairs file: inverted pairs hedge YES+YES; blocked pairs and wide auto pairs are skipped", async () => {
  const K = mk("kalshi", "K", 0.3, 0.31, { title: "Will the Fed cut rates by 25bps in December 2026?" });
  const P = mk("polymarket", "P", 0.62, 0.63, { title: "Fed cuts rates 25 bps in December 2026?", outcomes: ["Yes", "No"] });
  const inv = await discoverBaskets({
    cfg,
    pairs: { confirmed: [{ kalshi: "K", polymarket: "P", invert: true }], blocked: [] },
    markets: [K, P],
    eventGroups: [],
  });
  const sides = inv.baskets.map((b) => b.legs.map((l) => l.side).join("+")).sort();
  assert.deepEqual(sides, ["no+no", "yes+yes"]);

  const blocked = await discoverBaskets({
    cfg,
    pairs: { confirmed: [], blocked: [{ kalshi: "K", polymarket: "P" }] },
    markets: [K, P],
    eventGroups: [],
  });
  assert.equal(blocked.baskets.length, 0);

  // Auto-matched but 32¢ apart: almost certainly different questions.
  const wide = await discoverBaskets({ cfg, pairs: { confirmed: [], blocked: [] }, markets: [K, P], eventGroups: [] });
  assert.equal(wide.baskets.length, 0);
  assert.match(wide.skipped[0]?.reason ?? "", /apart/);
  assert.equal(wide.skipped[0]?.key, pairKey("K", "P"));
});

test("unwind proceeds use bids and exit fees", () => {
  const u = unwindProceeds(
    [
      { market: mk("kalshi", "K", 0.66, 0.67), side: "yes", contracts: 105 },
      { market: mk("polymarket", "P", 0.61, 0.62), side: "no", contracts: 105 },
    ],
    env,
  );
  assert.ok(u);
  assert.deepEqual(u!.prices.map((x) => Math.round(x * 1000) / 1000), [0.655, 0.375]);
  assert.equal(u!.proceedsUsd, 106.48);
});

test("a 'hedge' that loses on both legs counts as one loss, and two of them pause arbitrage", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "prb-arb-"));
  const rules = path.join(dir, "rules.yaml");
  await writeFile(
    rules,
    `rules:\n  - id: noop\n    name: noop\n    filters: { keywords_any: [zzzz] }\narbitrage:\n  cross_platform: { auto_match: false }\n  same_platform: { enabled: false }\n  unwind_early: false\n`,
  );
  // Two confirmed pairs that were NOT really the same question.
  await writeFile(
    path.join(dir, "arb-pairs.yaml"),
    `confirmed:\n  - { kalshi: K1, polymarket: P1 }\n  - { kalshi: K2, polymarket: P2 }\n`,
  );
  const open = (id: string, b: number, a: number, platform: PlatformId) => ({ ...mk(platform, id, b, a), closesInHours: 100 });
  const snap1 = path.join(dir, "s1.json");
  await writeFile(snap1, JSON.stringify([open("K1", 0.4, 0.41, "kalshi"), open("P1", 0.46, 0.47, "polymarket"), open("K2", 0.4, 0.41, "kalshi"), open("P2", 0.46, 0.47, "polymarket")]));
  const resolved = (id: string, platform: PlatformId, outcome: "yes" | "no") => ({
    platform, id, title: id, yesPrice: outcome === "yes" ? 1 : 0, status: "resolved", resolvedOutcome: outcome, closesInHours: -1,
  });
  // Kalshi resolves NO while Polymarket resolves YES: YES(K) and NO(P) both lose.
  const snap2 = path.join(dir, "s2.json");
  await writeFile(snap2, JSON.stringify([resolved("K1", "kalshi", "no"), resolved("P1", "polymarket", "yes"), resolved("K2", "kalshi", "no"), resolved("P2", "polymarket", "yes")]));

  const ledgerPath = path.join(dir, "ledger.json");
  const run = async (fixture: string, now: Date) => {
    const events: EngineEvent[] = [];
    const res = await runPaperCycle({
      rulesPath: rules,
      ledgerPath,
      demo: true,
      now,
      emit: (e) => {
        events.push(e);
      },
      adapters: (["kalshi", "polymarket"] as const).map((id) => new DemoAdapter(id, { fixturePath: fixture, now: () => now })),
    });
    return { ...res, events };
  };
  const r1 = await run(snap1, NOW);
  assert.equal(r1.arb?.opened, 2);
  const r2 = await run(snap2, new Date(NOW.getTime() + 3600_000));
  assert.equal(r2.arb?.closed, 2);
  assert.ok((r2.arb?.realizedPnlUsd ?? 0) < -150);
  assert.ok(r2.events.some((e) => e.type === "arb_close" && /LOSS/.test(e.message)));
  assert.ok(r2.events.some((e) => e.type === "risk_block" && e.ruleId === "arbitrage" && /pause armed/.test(e.message)));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8")) as PaperLedger;
  assert.ok(ledger.ruleState.arbitrage?.pausedUntil);
  assert.equal(Object.values(ledger.arbGroups ?? {}).filter((g) => g.status === "closed").length, 2);
});

test("scan reports arbitrage as alerts and never opens positions; watch alerts once", async () => {
  const events: EngineEvent[] = [];
  const lastMatched = new Set<string>();
  const opts = {
    rulesPath: path.join(ROOT, "rules/example.yaml"),
    demo: true,
    emit: (e: EngineEvent) => {
      events.push(e);
    },
    lastMatched,
  };
  await runScan(opts);
  const first = events.filter((e) => e.type === "arb_signal");
  assert.equal(first.length, 3);
  assert.ok(first.every((e) => e.data?.action === "alert"));
  assert.equal(events.filter((e) => e.type === "arb_open").length, 0);
  events.length = 0;
  await runScan(opts);
  assert.equal(events.filter((e) => e.type === "arb_signal").length, 0, "watch: no repeat alerts");
});
