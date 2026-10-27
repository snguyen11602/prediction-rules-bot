import path from "node:path";

export interface CliArgs {
  rules: string;
  demo: boolean;
  limit: number;
  intervalSec: number;
  logFile?: string;
  webhook?: string;
}

export function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const out: CliArgs = {
    rules: path.resolve("rules/example.yaml"),
    demo: false,
    limit: 80,
    intervalSec: Number(process.env.POLL_INTERVAL_SEC ?? 60),
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--demo") out.demo = true;
    else if (a === "--rules" && args[i + 1]) out.rules = path.resolve(args[++i]);
    else if (a === "--limit" && args[i + 1]) out.limit = Number(args[++i]);
    else if (a === "--interval" && args[i + 1]) out.intervalSec = Number(args[++i]);
    else if (a === "--log-file" && args[i + 1]) out.logFile = path.resolve(args[++i]);
    else if (a === "--webhook" && args[i + 1]) out.webhook = args[++i];
    else if (a === "--help" || a === "-h") {
      // eslint-disable-next-line no-console
      console.log(`Usage:
  npm run scan -- [--demo] [--rules path] [--limit N] [--log-file path] [--webhook url]
  npm run watch -- [--demo] [--interval sec] ...
  npm run paper -- [--demo] ...
  npm run live   # stub only — refuses unless gates pass (still not implemented)

Env: POLL_INTERVAL_SEC, WEBHOOK_URL, EVENT_LOG_FILE,
     ENABLE_LIVE_TRADING=true + ALLOW_LIVE=true required for any future live path.`);
      process.exit(0);
    }
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
