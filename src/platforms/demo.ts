import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedMarket, PlatformId } from "../types.js";
import { kalshiTakerFeeUsd } from "./kalshi.js";
import { polymarketTakerFeeUsd } from "./polymarket.js";
import type { EventGroup, ListMarketsOptions, PlatformAdapter } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_FIXTURE = path.resolve(__dirname, "../../fixtures/markets.json");

/**
 * Fixture rows are NormalizedMarket plus one fixture-only field:
 * `closesInHours` — close time relative to "now", so demo data never goes stale.
 */
type FixtureRow = NormalizedMarket & {
  closesInHours?: number;
  /** Fixture-only event metadata for same-platform arbitrage. */
  eventTitle?: string;
  mutuallyExclusive?: boolean;
  exhaustive?: boolean;
};

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

  private async fixtureRows(): Promise<FixtureRow[]> {
    const raw = await readFile(this.fixturePath, "utf8");
    return (JSON.parse(raw) as FixtureRow[]).filter((m) => m.platform === this.id);
  }

  private toMarket({ closesInHours, eventTitle: _t, mutuallyExclusive: _m, exhaustive: _e, ...m }: FixtureRow): NormalizedMarket {
    return closesInHours != null
      ? { ...m, closesAt: new Date(this.now().getTime() + closesInHours * 3600_000).toISOString() }
      : m;
  }

  private async rows(): Promise<NormalizedMarket[]> {
    return (await this.fixtureRows()).map((r) => this.toMarket(r));
  }

  async listEventGroups(opts: { limit?: number } = {}): Promise<EventGroup[]> {
    const byEvent = new Map<string, FixtureRow[]>();
    for (const r of await this.fixtureRows()) {
      if (!r.eventId) continue;
      byEvent.set(r.eventId, [...(byEvent.get(r.eventId) ?? []), r]);
    }
    const groups: EventGroup[] = [];
    for (const [eventId, rows] of byEvent) {
      if (rows.filter((r) => (r.status ?? "open") === "open").length < 2) continue;
      groups.push({
        platform: this.id,
        eventId,
        title: rows.find((r) => r.eventTitle)?.eventTitle ?? eventId,
        mutuallyExclusive: rows.some((r) => r.mutuallyExclusive),
        exhaustive: rows.some((r) => r.exhaustive),
        markets: rows.map((r) => this.toMarket(r)),
      });
    }
    return groups.slice(0, opts.limit ?? 100);
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

  estimateTakerFeeUsd(contracts: number, price: number, market?: NormalizedMarket): number {
    if (this.id === "kalshi") return kalshiTakerFeeUsd(contracts, price);
    // Demo Polymarket rows are fee-free unless they set takerFeeRate.
    return polymarketTakerFeeUsd(contracts, price, market?.takerFeeRate ?? 0);
  }

  async getMarkets(ids: string[]): Promise<NormalizedMarket[]> {
    const want = new Set(ids);
    return (await this.rows()).filter((m) => want.has(m.id));
  }

  roundContracts(contracts: number): number {
    return this.id === "kalshi" ? Math.floor(contracts + 1e-9) : contracts;
  }
}
