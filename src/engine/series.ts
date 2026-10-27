import { mkdir, open, readFile, rename } from "node:fs/promises";
import path from "node:path";
import type { NormalizedMarket } from "../types.js";

/**
 * Rolling price / volume history per market, built from our own snapshots
 * (one per scan). Platform-agnostic: it only stores what adapters already
 * return (YES mid price and 24h volume).
 */

export interface Tick {
  /** Epoch ms. */
  t: number;
  /** YES mid price (0–1). */
  p: number;
  /** Platform 24h volume at that moment, when known (units vary by platform; only ratios are used). */
  v?: number;
}

type Packed = [number, number] | [number, number, number];

interface SeriesFile {
  version: 1;
  series: Record<string, Packed[]>;
}

export interface SeriesOptions {
  /** Drop ticks older than this. */
  maxAgeHours?: number;
  /** Skip a new tick if the last one is more recent than this. */
  minSpacingSec?: number;
  /** Hard cap per market. */
  maxTicks?: number;
}

export class SeriesStore {
  private readonly data = new Map<string, Tick[]>();
  private readonly maxAgeMs: number;
  private readonly minSpacingMs: number;
  private readonly maxTicks: number;

  constructor(opts: SeriesOptions = {}, initial?: Record<string, Tick[]>) {
    this.maxAgeMs = (opts.maxAgeHours ?? 36) * 3600_000;
    this.minSpacingMs = (opts.minSpacingSec ?? 45) * 1000;
    this.maxTicks = opts.maxTicks ?? 800;
    for (const [k, v] of Object.entries(initial ?? {})) this.data.set(k, [...v].sort((a, b) => a.t - b.t));
  }

  static key(m: Pick<NormalizedMarket, "platform" | "id">): string {
    return `${m.platform}:${m.id}`;
  }

  record(markets: NormalizedMarket[], now: Date): void {
    const t = now.getTime();
    for (const m of markets) {
      if ((m.status ?? "open") !== "open" || !Number.isFinite(m.yesPrice)) continue;
      const k = SeriesStore.key(m);
      const list = this.data.get(k) ?? [];
      const last = list.at(-1);
      if (last && t - last.t < this.minSpacingMs) continue;
      if (last && t < last.t) continue; // never write into the past
      list.push({ t, p: m.yesPrice, ...(m.volume24hUsd != null && Number.isFinite(m.volume24hUsd) ? { v: m.volume24hUsd } : {}) });
      this.data.set(k, list);
    }
    this.prune(now);
  }

  get(key: string): Tick[] {
    return this.data.get(key) ?? [];
  }

  prune(now: Date): void {
    const cutoff = now.getTime() - this.maxAgeMs;
    for (const [k, list] of this.data) {
      const kept = list.filter((x) => x.t >= cutoff).slice(-this.maxTicks);
      if (kept.length) this.data.set(k, kept);
      else this.data.delete(k);
    }
  }

  get size(): number {
    return this.data.size;
  }

  toFile(): SeriesFile {
    const series: SeriesFile["series"] = {};
    for (const [k, list] of this.data) {
      series[k] = list.map((x) => (x.v != null ? [x.t, round4(x.p), Math.round(x.v)] : [x.t, round4(x.p)]));
    }
    return { version: 1, series };
  }

  static fromFile(file: SeriesFile, opts?: SeriesOptions): SeriesStore {
    const initial: Record<string, Tick[]> = {};
    for (const [k, rows] of Object.entries(file.series ?? {})) {
      initial[k] = rows
        .filter((r) => Array.isArray(r) && Number.isFinite(r[0]) && Number.isFinite(r[1]))
        .map((r) => (r.length > 2 && Number.isFinite(r[2]) ? { t: r[0], p: r[1], v: r[2] } : { t: r[0], p: r[1] }));
    }
    return new SeriesStore(opts, initial);
  }
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

/** data/paper-ledger.json → data/paper-ledger.history.json */
export function seriesPathFor(ledgerPath: string): string {
  const ext = path.extname(ledgerPath);
  return ext ? `${ledgerPath.slice(0, -ext.length)}.history${ext}` : `${ledgerPath}.history.json`;
}

/** Missing or unreadable history just starts fresh — it's a cache, not a record. */
export async function loadSeries(file: string, opts?: SeriesOptions): Promise<SeriesStore> {
  try {
    const data = JSON.parse(await readFile(file, "utf8")) as SeriesFile;
    if (data?.version !== 1) return new SeriesStore(opts);
    return SeriesStore.fromFile(data, opts);
  } catch {
    return new SeriesStore(opts);
  }
}

export async function saveSeries(file: string, store: SeriesStore): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const fh = await open(tmp, "w");
  try {
    await fh.writeFile(JSON.stringify(store.toFile()));
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
}
