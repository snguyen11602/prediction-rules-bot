import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { PaperFill, PlatformId, SignalSide } from "../types.js";

const DEFAULT_LEDGER = path.resolve("data/paper-ledger.json");

export interface PaperLedger {
  version: 1;
  fills: PaperFill[];
}

async function readLedger(filePath = DEFAULT_LEDGER): Promise<PaperLedger> {
  try {
    const raw = await readFile(filePath, "utf8");
    return JSON.parse(raw) as PaperLedger;
  } catch {
    return { version: 1, fills: [] };
  }
}

async function writeLedger(ledger: PaperLedger, filePath = DEFAULT_LEDGER): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

export async function recordPaperFill(input: {
  ruleId: string;
  platform: PlatformId;
  marketId: string;
  title: string;
  side: SignalSide;
  price: number;
  sizeUsd: number;
  filePath?: string;
}): Promise<PaperFill> {
  const filePath = input.filePath ?? DEFAULT_LEDGER;
  const ledger = await readLedger(filePath);
  const fill: PaperFill = {
    id: randomUUID(),
    at: new Date().toISOString(),
    ruleId: input.ruleId,
    platform: input.platform,
    marketId: input.marketId,
    title: input.title,
    side: input.side,
    price: input.price,
    sizeUsd: input.sizeUsd,
    hypothetical: true,
  };
  ledger.fills.push(fill);
  await writeLedger(ledger, filePath);
  return fill;
}

export async function listPaperFills(filePath = DEFAULT_LEDGER): Promise<PaperFill[]> {
  return (await readLedger(filePath)).fills;
}
