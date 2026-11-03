#!/usr/bin/env node
import { rmSync } from "node:fs";
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { runRound, type Contestant } from "../league/evolve.js";
import { activeMembers, leaguePathFor, loadLeague } from "../league/league.js";

/**
 * npm run league                 run a round now: backtest, rank, clone winners, retire losers
 * npm run league -- --show       print the leaderboard (no round)
 * Options: --rules path  --ledger path  --days N  --markets N  --seed N  --no-backtest  --demo
 *
 * Paper only. Backtests read public price history; nothing here can place an order.
 */

function parse(argv: string[]) {
  const o = {
    rules: path.resolve("rules/example.yaml"),
    ledger: undefined as string | undefined,
    demo: false,
    show: false,
    noBacktest: false,
    days: undefined as number | undefined,
    markets: undefined as number | undefined,
    seed: undefined as number | undefined,
  };
  const num = (flag: string, v: string | undefined, min: number) => {
    const n = Number(v);
    if (!Number.isFinite(n) || n < min) {
      console.error(`Invalid ${flag}: ${v ?? "(missing)"}`);
      process.exit(2);
    }
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rules" && argv[i + 1]) o.rules = path.resolve(argv[++i]);
    else if (a === "--ledger" && argv[i + 1]) o.ledger = path.resolve(argv[++i]);
    else if (a === "--demo") o.demo = true;
    else if (a === "--show") o.show = true;
    else if (a === "--no-backtest") o.noBacktest = true;
    else if (a === "--days") o.days = num(a, argv[++i], 2);
    else if (a === "--markets") o.markets = num(a, argv[++i], 5);
    else if (a === "--seed") o.seed = num(a, argv[++i], 0);
    else if (a === "--help" || a === "-h") {
      console.log("Usage: npm run league -- [--show] [--rules path] [--ledger path] [--days N] [--markets N] [--seed N] [--no-backtest] [--demo]");
      process.exit(0);
    } else {
      console.error(`Unknown flag: ${a} (see --help)`);
      process.exit(2);
    }
  }
  o.ledger ??= path.resolve(o.demo ? "data/paper-ledger.demo.json" : "data/paper-ledger.json");
  // Demo data has no price history to backtest on.
  if (o.demo) o.noBacktest = true;
  return o as typeof o & { ledger: string };
}

const pad = (s: string, n: number) => (s.length >= n ? s.slice(0, n - 1) + "…" : s.padEnd(n));
const money = (n: number) => `${n < 0 ? "-" : ""}$${Math.abs(n).toFixed(2)}`;

function table(rows: Contestant[]) {
  console.log(`\n ${pad("#", 3)}${pad("Strategy", 34)}${pad("Score", 8)}${pad("Profit", 10)}${pad("Win %", 7)}${pad("Trades", 7)}Note`);
  rows.forEach((c, i) => {
    const s = c.backtest?.all ?? c.paper;
    const tag = c.house ? "your rule" : c.member?.status ?? "";
    console.log(
      ` ${pad(String(i + 1), 3)}${pad(`${c.name} — ${c.style}`, 34)}${pad(c.ranked ? c.score.toFixed(1) : "—", 8)}${pad(money(s.pnlUsd), 10)}${pad(s.wins + s.losses ? `${Math.round(s.winRate * 100)}%` : "—", 7)}${pad(String(s.trades), 7)}${tag}`,
    );
  });
}

/** Exit code when another round is already running (paper:watch backs off on it). */
const BUSY_EXIT = 3;

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** One round at a time (paper:watch also starts rounds). The lock holds our PID. */
async function withRoundLock<T>(ledger: string, fn: () => Promise<T>): Promise<T | typeof BUSY> {
  const lock = path.join(path.dirname(ledger), "backtest", "round.lock");
  await mkdir(path.dirname(lock), { recursive: true });
  try {
    const pid = Number((await readFile(lock, "utf8")).trim());
    const age = Date.now() - (await stat(lock)).mtimeMs;
    // A lock from a process that's gone (or very old) is stale.
    if (Number.isInteger(pid) && pid > 0 && alive(pid) && age < 6 * 3600_000) {
      console.log(`A league round is already running (started ${Math.round(age / 60_000)} min ago). Try again later.`);
      return BUSY;
    }
    await rm(lock, { force: true });
  } catch {
    // no lock
  }
  let fh;
  try {
    fh = await open(lock, "wx");
  } catch {
    console.log("A league round just started elsewhere. Try again later.");
    return BUSY;
  }
  await fh.writeFile(String(process.pid));
  await fh.close();
  const release = () => rmSync(lock, { force: true });
  // Ctrl+C, or paper:watch stopping us: don't leave the lock behind.
  const onSignal = (sig: NodeJS.Signals) => {
    release();
    process.exit(sig === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    return await fn();
  } finally {
    release();
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
const BUSY = Symbol("busy");

async function main() {
  const o = parse(process.argv.slice(2));
  if (o.show) {
    const l = await loadLeague(leaguePathFor(o.ledger));
    if (!l.members.length) {
      console.log("No league yet. Run: npm run league");
      return;
    }
    console.log(`League round ${l.round} — ${activeMembers(l).length} playing`);
    for (const m of activeMembers(l)) {
      const s = m.backtest?.all;
      console.log(` ${pad(`${m.name} — ${m.style}`, 36)}${pad(m.status, 10)}${s ? `${money(s.pnlUsd)} over ${s.trades} backtest trades, score ${s.steadyScore.toFixed(1)}` : "not tested yet"}`);
    }
    return;
  }
  const res = await withRoundLock(o.ledger, () =>
    runRound({
      rulesPath: o.rules,
      ledgerPath: o.ledger,
      noBacktest: o.noBacktest,
      demo: o.demo,
      days: o.days,
      markets: o.markets,
      seed: o.seed,
      log: (m) => console.log(m),
    }),
  );
  if (res === BUSY) process.exit(BUSY_EXIT);
  const { summary } = res;
  if (summary.backtest) {
    const b = summary.backtest;
    console.log(`\nBacktest: ${Object.entries(b.markets).map(([p, n]) => `${n} ${p} markets`).join(", ")}, ${b.steps} hourly steps, ${b.seconds}s.`);
    for (const n of b.notes) console.log(`Note: ${n}`);
  }
  table(summary.standings);
  console.log("");
  if (summary.champion) console.log(`Champion: ${summary.champion.name} (${summary.champion.style})`);
  for (const m of summary.cloned) console.log(`Cloned:   ${m.name} — ${m.style}, generation ${m.generation}`);
  for (const m of summary.retired) console.log(`Retired:  ${m.name} — ${m.diagnosis?.headline ?? ""}`);
  console.log(`New:      ${summary.born.length} rookie(s). Open the dashboard → Leaderboard to see everyone.`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
