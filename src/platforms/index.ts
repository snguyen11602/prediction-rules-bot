import { DemoAdapter } from "./demo.js";
import { KalshiAdapter } from "./kalshi.js";
import { PolymarketAdapter } from "./polymarket.js";
import type { PlatformAdapter } from "./types.js";
import type { PlatformId } from "../types.js";

export type { PlatformAdapter, ListMarketsOptions } from "./types.js";
export { KalshiAdapter } from "./kalshi.js";
export { PolymarketAdapter } from "./polymarket.js";
export { DemoAdapter } from "./demo.js";

export function createAdapters(opts: {
  demo?: boolean;
  platforms?: PlatformId[];
}): PlatformAdapter[] {
  const wanted = opts.platforms ?? (["kalshi", "polymarket"] as PlatformId[]);
  if (opts.demo) {
    return wanted.map((id) => new DemoAdapter(id));
  }
  return wanted.map((id) => {
    if (id === "kalshi") return new KalshiAdapter();
    if (id === "polymarket") return new PolymarketAdapter();
    throw new Error(`Unknown platform: ${id}`);
  });
}
