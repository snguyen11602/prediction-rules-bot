import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { NormalizedMarket, PlatformId } from "../types.js";
import type { ListMarketsOptions, PlatformAdapter } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, "../../fixtures/markets.json");

/** Offline adapter — loads fixtures/markets.json for --demo mode. */
export class DemoAdapter implements PlatformAdapter {
  readonly id: PlatformId;
  constructor(id: PlatformId) {
    this.id = id;
  }

  async listMarkets(opts: ListMarketsOptions = {}): Promise<NormalizedMarket[]> {
    const raw = await readFile(FIXTURE, "utf8");
    const all = JSON.parse(raw) as NormalizedMarket[];
    let rows = all.filter((m) => m.platform === this.id);
    if (opts.query) {
      const q = opts.query.toLowerCase();
      rows = rows.filter((m) => m.title.toLowerCase().includes(q));
    }
    return rows.slice(0, opts.limit ?? 100);
  }
}
