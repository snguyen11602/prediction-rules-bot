import path from "node:path";

export interface CliArgs {
  rules: string;
  demo: boolean;
  limit: number;
  intervalSec: number;
  logFile?: string;
  webhook?: string;
  /** Demo only: alternate fixture file (e.g. fixtures/markets.later.json). */
  fixture?: string;
  /** Paper ledger path (default data/paper-ledger.json, or .demo.json with --demo). */
  ledger?: string;
  /** Paper every enabled rule, not only action: paper rules. */
  paperAll: boolean;
  /** Paper: repeat every --interval seconds. */
  loop: boolean;
  /** Report: print JSON instead of a table. */
  json: boolean;
  /** paper:close — position id (or unique prefix). */
  id?: string;
  /** paper:close — exit price for the held side (0–1). */
  price?: number;
}

function intArg(name: string, raw: string | undefined, min: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min) {
    // eslint-disable-next-line no-console
    console.error(`Invalid ${name}: ${raw ?? "(missing)"} (expected a number >= ${min})`);
    process.exit(2);
  }
  return n;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = {
    rules: path.resolve("rules/example.yaml"),
    demo: false,
    limit: 80,
    intervalSec: Number(process.env.POLL_INTERVAL_SEC ?? 60),
    paperAll: false,
    loop: false,
    json: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--demo") out.demo = true;
    else if (a === "--rules" && args[i + 1]) out.rules = path.resolve(args[++i]);
    else if (a === "--limit") out.limit = intArg("--limit", args[++i], 1);
    else if (a === "--interval") out.intervalSec = intArg("--interval", args[++i], 1);
    else if (a === "--log-file" && args[i + 1]) out.logFile = path.resolve(args[++i]);
    else if (a === "--webhook" && args[i + 1]) out.webhook = args[++i];
    else if (a === "--fixture" && args[i + 1]) out.fixture = path.resolve(args[++i]);
    else if (a === "--ledger" && args[i + 1]) out.ledger = path.resolve(args[++i]);
    else if (a === "--paper-all") out.paperAll = true;
    else if (a === "--loop") out.loop = true;
    else if (a === "--json") out.json = true;
    else if (a === "--id" && args[i + 1]) out.id = args[++i];
    else if (a === "--price") {
      const n = Number(args[++i]);
      if (!(n >= 0 && n <= 1)) {
        // eslint-disable-next-line no-console
        console.error(`Invalid --price: ${args[i]} (expected 0–1, the held contract's value)`);
        process.exit(2);
      }
      out.price = n;
    }
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(`Usage:
  npm run scan -- [--demo [--fixture path]] [--rules path] [--limit N] [--log-file path] [--webhook url]
  npm run watch -- [--demo] [--interval sec] ...      # alerts only, repeats suppressed
  npm run paper -- [--demo [--fixture path]] [--ledger path] [--paper-all] [--loop [--interval sec]] ...
  npm run paper:report -- [--demo] [--ledger path] [--json]
  npm run paper:close -- --id <position id> --price <0-1> [--demo] [--ledger path]
  npm run live   # stub only — refuses unless gates pass (still not implemented)

Paper ledger defaults: data/paper-ledger.json (real data), data/paper-ledger.demo.json (--demo).
Paper fills only rules with action: paper (pass --paper-all to paper every rule).

Env: POLL_INTERVAL_SEC, WEBHOOK_URL, EVENT_LOG_FILE,
     ENABLE_LIVE_TRADING=true + ALLOW_LIVE=true required for any future live path.`);
      process.exit(0);
    } else if (a.startsWith("--")) {
      // eslint-disable-next-line no-console
      console.error(`Unknown or incomplete flag: ${a} (see --help)`);
      process.exit(2);
    }
  }

  if (out.fixture && !out.demo) {
    // eslint-disable-next-line no-console
    console.error("--fixture only applies with --demo");
    process.exit(2);
  }

  if (process.env.WEBHOOK_URL && !out.webhook) out.webhook = process.env.WEBHOOK_URL;
  if (process.env.EVENT_LOG_FILE && !out.logFile) out.logFile = process.env.EVENT_LOG_FILE;

  return out;
}

export function buildEmit(args: CliArgs) {
  // lazy import to keep cli thin
  return import("../engine/events.js").then(({ consoleSink, fileSink, webhookSink, multiSink }) => {
    const sinks = [consoleSink];
    if (args.logFile) sinks.push(fileSink(args.logFile));
    if (args.webhook) sinks.push(webhookSink(args.webhook));
    return multiSink(...sinks);
  });
}
