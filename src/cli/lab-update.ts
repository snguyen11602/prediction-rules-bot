#!/usr/bin/env node
/**
 * npm run lab:update [-- --days 90]
 * Download (or top up) the backtest lab's game history: Kalshi's settled game-winner markets and
 * their hourly pre-game prices. Public data, read-only, no keys. The first run takes a few
 * minutes; later runs only fetch new games. The dashboard's lab has a button that does the same.
 */
import path from "node:path";
import { downloadLab, loadLab, saveLab, summarizeLab } from "../lab/data.js";

async function main() {
  const i = process.argv.indexOf("--days");
  const days = i >= 0 ? Number(process.argv[i + 1]) : 90;
  if (!Number.isFinite(days) || days < 1) throw new Error("--days needs a number, e.g. --days 90");
  const file = path.resolve("data/lab-games.json");
  const existing = await loadLab(file);
  console.log(existing ? `Topping up ${file} (${existing.markets.length} markets on disk)…` : `Downloading the last ${days} days of settled games to ${file} (a few minutes)…`);
  const data = await downloadLab({
    days,
    existing,
    onProgress: (p) => process.stderr.write(p.stage === "games" ? `  finding games: ${p.note ?? ""}            \r` : `  prices: ${p.done} / ${p.total}            \r`),
  });
  process.stderr.write("\n");
  await saveLab(file, data);
  const s = summarizeLab(data);
  console.log(`Saved ${s.games} games (${s.markets} markets), ${s.from?.slice(0, 10)} to ${s.to?.slice(0, 10)}.`);
  console.log(s.leagues.map((l) => `  ${l.label}: ${l.games}`).join("\n"));
}

main().catch((err) => {
  console.error((err as Error).message);
  process.exit(1);
});
