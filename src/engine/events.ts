import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { EngineEvent } from "../types.js";

export type EventSink = (event: EngineEvent) => void | Promise<void>;

export function consoleSink(event: EngineEvent): void {
  const tag = event.type.toUpperCase().padEnd(14);
  const bits = [
    event.at,
    tag,
    event.ruleId ? `[${event.ruleId}]` : "",
    event.message,
  ].filter(Boolean);
  if (event.market) {
    bits.push(
      `| ${event.market.platform}:${event.market.id} yes=${event.market.yesPrice.toFixed(3)}`,
    );
  }
  // eslint-disable-next-line no-console
  console.log(bits.join(" "));
}

export function fileSink(filePath: string): EventSink {
  const abs = path.resolve(filePath);
  return async (event) => {
    await mkdir(path.dirname(abs), { recursive: true });
    await appendFile(abs, `${JSON.stringify(event)}\n`, "utf8");
  };
}

export function webhookSink(url: string): EventSink {
  return async (event) => {
    try {
      await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`Webhook failed: ${(err as Error).message}`);
    }
  };
}

export function multiSink(...sinks: EventSink[]): EventSink {
  return async (event) => {
    for (const s of sinks) await s(event);
  };
}
