#!/usr/bin/env node
/**
 * Local paper-trading dashboard at http://localhost:4321 (127.0.0.1 only).
 *
 *   npm run dashboard     view the paper ledger (read-only)
 *   npm run paper:watch   also run a paper cycle every --interval seconds (default 300)
 *   npm run paper:fast    same, plus live streamed prices and a quick check every --tick seconds
 *                         (needs Kalshi / Polymarket US API keys in .env; read-only market data)
 *
 * Hypothetical only: the paper loop uses public market data and the local ledger.
 * Nothing here imports or calls order-placement code.
 */
import { spawn } from "node:child_process";
import { parseArgs } from "./args.js";
import { runPaperCycle } from "../engine/paper-session.js";
import { consoleSink, fileSink, webhookSink, type EventSink } from "../engine/events.js";
import { defaultLedgerPath } from "../ledger/paper.js";
import { createDashboardServer, type LoopState } from "../dashboard/server.js";
import type { EngineEvent, NormalizedMarket, PlatformId } from "../types.js";
import { COPY_RULE_ID } from "../rules/schema.js";
import type { PlatformAdapter } from "../platforms/types.js";
import { loadDotEnv, readStreamCreds } from "../live-data/credentials.js";
import { QuoteBook } from "../live-data/quotes.js";
import { KalshiStream, PolymarketUsStream, type AnyStream } from "../live-data/streams.js";
import { LiveQuoteAdapter } from "../live-data/live-adapter.js";

/** Fast mode plumbing: one quote book, one stream per platform with keys, one cached adapter per platform. */
function setUpFastMode(args: ReturnType<typeof parseArgs>, intervalSec: number, log: (m: string) => void) {
  if (args.demo) return { note: "Fast mode streams real prices, so it's off with --demo." };
  loadDotEnv();
  const creds = readStreamCreds();
  for (const p of creds.problems) log(`⚠ ${p}`);
  const quotes = new QuoteBook();
  const streams = new Map<PlatformId, AnyStream>();
  if (creds.kalshi) streams.set("kalshi", new KalshiStream(quotes, creds.kalshi, { log }));
  if (creds.polymarketUs) streams.set("polymarket_us", new PolymarketUsStream(quotes, creds.polymarketUs, { log }));
  if (!streams.size) {
    return { note: "Fast mode needs your Kalshi and/or Polymarket US API keys in .env (see README). Running normal checks." };
  }
  // Per platform: the scanned list (replaced on every refresh) plus single lookups such as
  // markets we hold, so a held market keeps streaming after it drops out of the list.
  const listed = new Map<PlatformId, Map<string, NormalizedMarket>>();
  const looked = new Map<PlatformId, Map<string, NormalizedMarket>>();
  const watch = (platform: PlatformId, markets: NormalizedMarket[], source: "listing" | "lookup") => {
    const stream = streams.get(platform);
    if (!stream) return;
    const target = source === "listing" ? new Map<string, NormalizedMarket>() : looked.get(platform) ?? new Map();
    for (const m of markets) if ((m.status ?? "open") === "open") target.set(m.id, m);
    (source === "listing" ? listed : looked).set(platform, target);
    const all = new Map([...(listed.get(platform) ?? []), ...(looked.get(platform) ?? [])]);
    if (stream instanceof PolymarketUsStream) {
      stream.setSlugs([...all.values()].map((m) => ({ id: m.id, slug: String((m.raw as { slug?: string } | undefined)?.slug ?? "") })).filter((x) => x.slug));
    } else stream.setMarkets([...all.keys()]);
  };
  const wrappers = new Map<PlatformId, LiveQuoteAdapter>();
  const wrap = (list: PlatformAdapter[]) =>
    list.map((a) => {
      let w = wrappers.get(a.id);
      if (!w) {
        w = new LiveQuoteAdapter(a, quotes, {
          // Full checks refresh explicitly; this is only a backstop so quick checks never hit REST.
          refreshMs: intervalSec * 2000,
          maxQuoteAgeMs: 15 * 60_000,
          watch: (ms, source) => watch(a.id, ms, source),
        });
        wrappers.set(a.id, w);
      }
      return w;
    });
  for (const s of streams.values()) s.start();
  return { quotes, streams, wrappers, wrap };
}

const MAX_EVENTS = 300;
const QUIET_TYPES = new Set(["paper_fill", "paper_exit", "paper_summary", "adapter_error", "arb_open", "arb_close"]);

function openBrowser(url: string) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open";
  const argv = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  try {
    spawn(cmd, argv, { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    // no browser available — the URL is printed anyway
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const ledgerPath = args.ledger ?? defaultLedgerPath(args.demo);
  const intervalSec = args.intervalSet ? args.intervalSec : 300;

  const events: EngineEvent[] = [];
  const loop: LoopState = { enabled: args.paper, intervalSec: args.paper ? intervalSec : undefined, running: false };

  // Alerts repeat every cycle while a market keeps matching; keep only new ones in the feed.
  let prevAlertKeys = new Set<string>();
  let alertKeys = new Set<string>();
  const remember = (e: EngineEvent) => {
    if (e.type === "scan_start") {
      prevAlertKeys = alertKeys;
      alertKeys = new Set();
    }
    if (e.type === "entry_signal" && e.data?.action === "alert" && e.market) {
      const key = `${e.ruleId}|${e.market.platform}:${e.market.id}`;
      alertKeys.add(key);
      if (prevAlertKeys.has(key)) return;
    }
    if (e.type === "arb_signal") {
      const key = `arb|${String(e.data?.key ?? e.message)}`;
      alertKeys.add(key);
      if (prevAlertKeys.has(key)) return;
    }
    if (e.type === "info" || e.type === "market_match" || e.type === "scan_start" || e.type === "scan_end") return;
    events.push(e);
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS);
  };

  const server = createDashboardServer({
    ledgerPath,
    rulesPath: args.rules,
    demo: args.demo,
    getLoop: () => ({ ...loop }),
    getEvents: () => events,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        reject(new Error(`Port ${args.port} is already in use — is the dashboard already open? Try --port ${args.port + 1}.`));
      } else reject(err);
    });
    server.listen(args.port, "127.0.0.1", () => resolve());
  });

  const url = `http://localhost:${args.port}`;
  console.log(`\nDashboard: ${url}${args.demo ? "  [DEMO]" : ""}`);
  console.log(args.paper
    ? `Paper trading every ${Math.round(intervalSec / 60) >= 1 ? `${Math.round(intervalSec / 60)} min` : `${intervalSec}s`} → ${ledgerPath}`
    : `Read-only view of ${ledgerPath} (start "npm run paper:watch" to trade and watch together)`);
  console.log("Pretend money only. Press Ctrl+C to stop.\n");
  if (!args.noOpen) openBrowser(url);

  let stopping = false;
  let ticking = false; // a quick check holds the ledger lock too
  const shutdown = () => {
    if (stopping || !(loop.running || ticking)) {
      server.close();
      process.exit(stopping ? 130 : 0);
    }
    stopping = true;
    console.error("Stopping after the current check… (Ctrl+C again to force)");
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (!args.paper) return; // server keeps the process alive

  const fast = args.fast ? setUpFastMode(args, intervalSec, (m) => console.error(m)) : undefined;
  const fastOn = !!fast && "wrap" in fast;
  if (fast) {
    loop.fast = { tickSec: args.tickSec, ticks: 0, streams: [], note: "note" in fast ? fast.note : undefined };
    if (loop.fast.note) console.error(loop.fast.note);
    else console.log(`Fast mode: live prices from ${[...fast.streams!.keys()].join(" + ")}, quick check every ${args.tickSec}s.\n`);
  }
  const streamStatus = () => (fastOn ? [...fast!.streams!.values()].map((s) => ({ ...s.status })) : []);

  // Terminal shows only trades and problems; --log-file / --webhook still get every event.
  const extraSinks: EventSink[] = [];
  if (args.logFile) extraSinks.push(fileSink(args.logFile));
  if (args.webhook) extraSinks.push(webhookSink(args.webhook));
  const emit = async (e: EngineEvent) => {
    remember(e);
    if (QUIET_TYPES.has(e.type) || (e.type === "risk_block" && /pause armed/i.test(e.message))) consoleSink(e);
    for (const sink of extraSinks) {
      try {
        await sink(e);
      } catch {
        // a failing log/webhook sink must not stop paper trading
      }
    }
  };

  // Fast checks print only trades and problems, and add them to the feed.
  const FAST_TYPES = new Set(["paper_fill", "paper_exit", "arb_close", "adapter_error"]);
  const fastEmit = async (e: EngineEvent) => {
    const copyAlert = e.type === "entry_signal" && e.ruleId === COPY_RULE_ID;
    if (!FAST_TYPES.has(e.type) && !copyAlert && !(e.type === "risk_block" && /pause armed/i.test(e.message))) return;
    await emit(e);
  };

  let nextFullAt = 0;
  while (!stopping) {
    const full = !fastOn || Date.now() >= nextFullAt;
    if (!full) {
      ticking = true;
      try {
        const tick = await runPaperCycle({
          rulesPath: args.rules,
          ledgerPath,
          demo: args.demo,
          limitPerPlatform: args.limit,
          paperAll: args.paperAll,
          emit: fastEmit,
          wrapAdapters: fast!.wrap,
          fastTick: true,
        });
        if (tick.copy) loop.copy = tick.copy;
        loop.fast!.ticks += 1;
        loop.fast!.lastTickAt = new Date().toISOString();
      } catch (err) {
        console.error(`Fast check failed: ${(err as Error).message}`);
      }
      ticking = false;
      loop.fast!.streams = streamStatus();
      if (stopping) break;
      await new Promise((r) => setTimeout(r, args.tickSec * 1000));
      continue;
    }
    if (fastOn) for (const w of fast!.wrappers!.values()) w.refresh();
    loop.running = true;
    loop.nextRunAt = undefined;
    try {
      const res = await runPaperCycle({
        rulesPath: args.rules,
        ledgerPath,
        demo: args.demo,
        fixturePath: args.fixture,
        limitPerPlatform: args.limit,
        paperAll: args.paperAll,
        emit,
        wrapAdapters: fastOn ? fast!.wrap : undefined,
      });
      const end = res.events.find((e) => e.type === "scan_end");
      loop.lastResult = {
        opened: res.opened,
        closed: res.closed,
        realizedPnlUsd: res.realizedPnlUsd,
        markets: typeof end?.data?.markets === "number" ? end.data.markets : undefined,
      };
      loop.arbOpportunities = res.arb?.opportunities;
      loop.trace = res.trace;
      loop.arbTrace = res.arbTrace;
      loop.copy = res.copy;
      loop.unusualMoves = res.events
        .filter((e) => e.type === "entry_signal" && e.data?.unusual && e.market)
        .map((e) => ({
          ruleId: e.ruleId,
          action: String(e.data?.action ?? ""),
          platform: e.market!.platform,
          id: e.market!.id,
          title: e.market!.title,
          url: e.market!.url,
          yesPrice: e.market!.yesPrice,
          side: e.side,
          move: e.data!.unusual as NonNullable<LoopState["unusualMoves"]>[number]["move"],
        }))
        // One row per market; if any rule paper-traded it, show that rather than the alert.
        .sort((a, b) => Number(b.action === "paper") - Number(a.action === "paper"))
        .filter((m, i, all) => all.findIndex((x) => x.platform === m.platform && x.id === m.id) === i);
      loop.arbCheckedAt = new Date().toISOString();
      loop.lastError = undefined;
    } catch (err) {
      loop.lastError = (err as Error).message;
      console.error(`Paper check failed: ${loop.lastError}`);
    }
    loop.running = false;
    loop.lastRunAt = new Date().toISOString();
    if (loop.fast) loop.fast.streams = streamStatus();
    if (stopping) break;
    loop.nextRunAt = new Date(Date.now() + intervalSec * 1000).toISOString();
    if (fastOn) {
      nextFullAt = Date.now() + intervalSec * 1000;
      await new Promise((r) => setTimeout(r, args.tickSec * 1000));
    } else await new Promise((r) => setTimeout(r, intervalSec * 1000));
  }
  if (fastOn) for (const st of fast!.streams!.values()) st.stop();
  server.close();
  process.exit(0);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
