import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedMarket, PlatformId } from "../types.js";
import { kalshiTakerFeeUsd } from "./kalshi.js";
import type { ListMarketsOptions, PlatformAdapter } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = path.resolve(__dirname, "../../fixtures/markets.json");

/**
 * Fixture rows are NormalizedMarket plus one fixture-only field:
 * `closesInHours` — close time relative to "now", so demo data never goes stale.
 */
type FixtureRow = NormalizedMarket & { closesInHours?: number };

/** Offline adapter — loads a fixture file (default fixtures/markets.json) for --demo mode. */
export class DemoAdapter implements PlatformAdapter {
  readonly id: PlatformId;
  private readonly fixturePath: string;
  private readonly now: () => Date;

  constructor(id: PlatformId, opts: { fixturePath?: string; now?: () => Date } = {}) {
    this.id = id;
    this.fixturePath = opts.fixturePath ? path.resolve(opts.fixturePath) : DEFAULT_FIXTURE;
    this.now = opts.now ?? (() => new Date());
  }

  private async rows(): Promise<NormalizedMarket[]> {
    const raw = await readFile(this.fixturePath, "utf8");
    const all = JSON.parse(raw) as FixtureRow[];
    const nowMs = this.now().getTime();
    return all
      .filter((m) => m.platform === this.id)
      .map(({ closesInHours, ...m }) =>
        closesInHours != null
          ? { ...m, closesAt: new Date(nowMs + closesInHours * 3600_000).toISOString() }
          : m,
      );
  }

  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    let rows = (await this.rows()).filter((m) => (m.status ?? "open") === "open");
    if (opts.query) {
      const q = opts.query.toLowerCase();
      rows = rows.filter((m) => m.title.toLowerCase().includes(q));
    }
    return rows.slice(0, opts.limit ?? 100);
  }

  async getMarket(id: string): Promise<NormalizedMarket | null> {
    return (await this.rows()).find((m) => m.id === id) ?? null;
  }

  estimateTakerFeeUsd(contracts: number, price: number): number {
    return this.id === "kalshi" ? kalshiTakerFeeUsd(contracts, price) : 0;
  }
}
