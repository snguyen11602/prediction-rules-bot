import { test } from "node:test";
import assert from "node:assert/strict";
import { findMatches, titleFeatures } from "./match.js";
import type { NormalizedMarket } from "../types.js";

const CLOSE = "2026-12-10T19:00:00Z";
const k = (id: string, title: string, over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform: "kalshi",
  id,
  title,
  yesPrice: 0.5,
  closesAt: CLOSE,
  ...over,
});
const p = (id: string, title: string, over: Partial<NormalizedMarket> = {}): NormalizedMarket => ({
  platform: "polymarket",
  id,
  title,
  yesPrice: 0.5,
  closesAt: CLOSE,
  outcomes: ["Yes", "No"],
  ...over,
});
const OPTS = { minScore: 0.5, maxCloseGapHours: 168 };

test("titles normalize numbers, money, months and direction words", () => {
  const a = titleFeatures("Fed decision in Dec 2026? — Cut 25bps");
  assert.deepEqual([...a.numbers], ["25"]);
  assert.deepEqual([...a.years], ["2026"]);
  assert.deepEqual([...a.polarity], ["down"]);
  assert.ok(a.content.has("december") && a.content.has("fed"));

  assert.deepEqual([...titleFeatures("Bitcoin above $60k on Friday?").numbers], ["60000"]);
  assert.deepEqual([...titleFeatures("Bitcoin above $60,000 on Friday?").numbers], ["60000"]);
  assert.deepEqual([...titleFeatures("Will the Federal Reserve hold rates?").polarity], ["hold"]);
  assert.deepEqual([...titleFeatures("Will there be no change in Fed interest rates?").polarity], ["hold"]);
});

test("the same question on both platforms matches", () => {
  const m = findMatches(
    [k("K-C25", "Fed decision in December 2026? — Cut 25bps")],
    [p("P-25", "Will the Fed decrease interest rates by 25 bps after the December 2026 meeting?")],
    OPTS,
  );
  assert.equal(m.length, 1);
  assert.ok(m[0].score >= 0.5, `score ${m[0].score}`);
});

test("look-alikes with different numbers or directions never match", () => {
  const poly = [p("P-25", "Will the Fed decrease interest rates by 25 bps after the December 2026 meeting?")];
  for (const title of [
    "Fed decision in December 2026? — Cut 50bps",
    "Fed decision in December 2026? — Hike 25bps",
    "Fed decision in December 2026? — Hold",
    "Fed decision in December 2027? — Cut 25bps",
  ]) {
    assert.equal(findMatches([k("K", title)], poly, OPTS).length, 0, title);
  }
  // above vs below the same strike
  assert.equal(
    findMatches([k("K", "Bitcoin above $100k on December 31, 2026?")], [p("P", "Bitcoin below $100,000 on December 31, 2026?")], OPTS).length,
    0,
  );
});

test("different people / places in the same kind of market don't match", () => {
  const ks = [k("K-PA", "Will Trump win Pennsylvania in the 2028 presidential election?")];
  const ps = [
    p("P-OH", "Will Trump win Ohio in the 2028 presidential election?"),
    p("P-V", "Will Vance win Pennsylvania in the 2028 presidential election?"),
  ];
  assert.equal(findMatches(ks, ps, OPTS).length, 0);
});

test("other safety checks: Yes/No outcomes, close dates, implied year, one-to-one", () => {
  const kal = k("K", "Will the Fed cut rates by 25bps in December 2026?");
  const same = "Fed cuts rates 25 bps in December 2026?";
  assert.equal(findMatches([kal], [p("P", same, { outcomes: ["Trump", "Harris"] })], OPTS).length, 0);
  assert.equal(findMatches([kal], [p("P", same, { closesAt: "2027-03-01T00:00:00Z" })], OPTS).length, 0);
  // Year only on one side is fine when the other market closes that year.
  assert.equal(findMatches([k("K", "Will the Fed cut rates by 25bps in December?")], [p("P", same)], OPTS).length, 1);
  // Each market is used at most once.
  const two = findMatches([kal, k("K2", "Fed to cut 25bps in December 2026")], [p("P", same)], OPTS);
  assert.equal(two.length, 1);
});

test("review mode returns near misses with a reason", () => {
  const m = findMatches(
    [k("K", "Fed decision in December 2026? — Cut 50bps")],
    [p("P", "Will the Fed decrease interest rates by 25 bps after the December 2026 meeting?")],
    { ...OPTS, includeRejected: true, reviewFloor: 0.2 },
  );
  assert.equal(m.length, 1);
  assert.equal(m[0].ok, false);
  assert.equal(m[0].reason, "numbers differ");
});
