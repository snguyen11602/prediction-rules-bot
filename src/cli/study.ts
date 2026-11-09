#!/usr/bin/env node
/**
 * npm run study [-- --days 60] [--since 2026-11-10]
 * Re-checks the bot's ideas against Kalshi's settled games (public data, read-only, no keys).
 */
import { getJson } from "../platforms/http.js";
import { KALSHI_GAME_SERIES, kalshiTimes } from "../platforms/kalshi.js";
import { formatRows, runStudy, type PathPoint, type StudyMarket } from "../study/study.js";

const BASE = process.env.KALSHI_API_BASE?.replace(/\/$/, "") ?? "https://api.elections.kalshi.com/trade-api/v2";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

interface Raw {
  ticker: string;
  event_ticker?: string;
  result?: string;
  expected_expiration_time?: string;
  latest_expiration_time?: string;
  close_time?: string;
}

async function settled(series: string, sinceMs: number): Promise<StudyMarket[]> {
  const out: StudyMarket[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 30; page++) {
    const url = new URL(`${BASE}/markets`);
    url.searchParams.set("series_ticker", series);
    url.searchParams.set("status", "settled");
    url.searchParams.set("limit", "1000");
    if (cursor) url.searchParams.set("cursor", cursor);
    const data = (await getJson<{ markets?: Raw[]; cursor?: string }>(url, "Kalshi", { retries: 6 })).data ?? {};
    let older = 0;
    for (const m of data.markets ?? []) {
      const start = Date.parse(kalshiTimes(m).startsAt ?? "");
      if (!Number.isFinite(start) || (m.result !== "yes" && m.result !== "no")) continue;
      if (start < sinceMs) {
        older++;
        continue;
      }
      out.push({ ticker: m.ticker, event: m.event_ticker ?? m.ticker, series, result: m.result, start });
    }
    cursor = data.cursor;
    // Newest first: once a whole page is older than the window, stop.
    if (!cursor || !data.markets?.length || older === data.markets.length) break;
    await sleep(250);
  }
  return out;
}

interface CandleSet {
  market_ticker?: string;
  ticker?: string;
  candlesticks?: Array<{ end_period_ts?: number; yes_bid?: { close_dollars?: string }; yes_ask?: { close_dollars?: string } }>;
}

async function pathsFor(markets: StudyMarket[]): Promise<Map<string, PathPoint[]>> {
  const out = new Map<string, PathPoint[]>();
  const sorted = [...markets].sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i += 40) {
    const chunk = sorted.slice(i, i + 40);
    const url = new URL(`${BASE}/markets/candlesticks`);
    url.searchParams.set("market_tickers", chunk.map((m) => m.ticker).join(","));
    url.searchParams.set("start_ts", String(Math.floor(Math.min(...chunk.map((m) => m.start)) / 1000) - 26 * 3600));
    url.searchParams.set("end_ts", String(Math.floor(Math.max(...chunk.map((m) => m.start)) / 1000) + 3600));
    url.searchParams.set("period_interval", "60");
    const data = (await getJson<{ markets?: CandleSet[] }>(url, "Kalshi", { retries: 6 }).catch(() => ({ data: undefined }))).data ?? {};
    const by = new Map((data.markets ?? []).map((s) => [s.market_ticker ?? s.ticker ?? "", s.candlesticks ?? []]));
    for (const m of chunk) {
      const pts: PathPoint[] = [];
      for (const c of by.get(m.ticker) ?? []) {
        const end = (c.end_period_ts ?? 0) * 1000;
        if (!end || end > m.start || end < m.start - 26 * 3600_000) continue;
        pts.push({ h: Math.round((m.start - end) / 3600_000), bid: Number(c.yes_bid?.close_dollars), ask: Number(c.yes_ask?.close_dollars) });
      }
      out.set(m.ticker, pts);
    }
    if ((i / 40) % 25 === 0) process.stderr.write(`  prices ${Math.min(i + 40, sorted.length)} / ${sorted.length}\r`);
    await sleep(200);
  }
  process.stderr.write("\n");
  return out;
}

async function main() {
  const days = Number(arg("days") ?? 60);
  const since = arg("since") ? Date.parse(`${arg("since")}T00:00:00Z`) : Date.now() - days * 86_400_000;
  if (!Number.isFinite(since)) throw new Error("--since needs a date like 2026-11-10");
  console.log(`Study: settled Kalshi games since ${new Date(since).toISOString().slice(0, 10)} (public data, a few minutes)…`);
  const markets: StudyMarket[] = [];
  for (const s of KALSHI_GAME_SERIES) {
    try {
      const got = await settled(s, since);
      markets.push(...got);
      process.stderr.write(`  ${s}: ${got.length} markets\n`);
    } catch (err) {
      process.stderr.write(`  ${s}: skipped (${(err as Error).message})\n`);
    }
  }
  if (!markets.length) {
    console.log("No settled games in that window yet.");
    return;
  }
  const report = runStudy(markets, await pathsFor(markets));
  console.log(`\n${report.games} games, ${report.markets} markets, ${report.from} to ${report.to}. Bought at the ask one hour before the start unless it says otherwise; held to the result; fee included.\n`);
  console.log("1. Buy the favorite, hold to the result");
  console.log(formatRows(report.favorites));
  console.log("\n2. Buy the long shot");
  console.log(formatRows(report.longShots));
  console.log("\n3. Buy the side whose price rose before the game (the late-mover rule)");
  console.log(formatRows(report.lateMovers));
  console.log("\nHow to read it: \"±\" is one standard error. A result is only called real when it is two or more standard errors from zero and has at least 100 bets. Anything else is within luck.");
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
