import { DemoAdapter } from "./demo.js";
import { KalshiAdapter } from "./kalshi.js";
import { PolymarketAdapter } from "./polymarket.js";
import type { PlatformAdapter } from "./types.js";
import type { PlatformId } from "../types.js";

export type { PlatformAdapter, ListMarketsOptions, EventGroup } from "./types.js";
export { KalshiAdapter } from "./kalshi.js";
export { PolymarketAdapter } from "./polymarket.js";
export { DemoAdapter } from "./demo.js";

export function createAdapters(opts: {
  demo?: boolean;
  platforms?: PlatformId[];
  /** Demo only: alternate fixture file (e.g. a later price snapshot). */
  fixturePath?: string;
}): PlatformAdapter[] {
  const wanted = opts.platforms ?? (["kalshi", "polymarket"] as PlatformId[]);
  if (opts.demo) {
    return wanted.map((id) => new DemoAdapter(id, { fixturePath: opts.fixturePath }));
  }
  return wanted.map((id) => {
    if (id === "kalshi") return new KalshiAdapter();
    if (id === "polymarket") return new PolymarketAdapter();
    throw new Error(`Unknown platform: ${id}`);
  });
}
