import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadRulesFile } from "../rules/loader.js";
import { loadLedger, summarizeLedger, type PaperPosition } from "../ledger/paper.js";
import type { EngineEvent } from "../types.js";

/**
 * Local, read-only paper-trading dashboard. Serves one page plus a JSON
 * snapshot of the paper ledger. Binds to 127.0.0.1 only; never places orders
 * and never writes the ledger (the optional paper loop lives in the CLI).
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PAGE_CANDIDATES = [
  path.join(__dirname, "index.html"),
  path.resolve(__dirname, "../../src/dashboard/index.html"), // when running from dist/
];

export interface LoopState {
  /** True when this process is also running paper cycles. */
  enabled: boolean;
  intervalSec?: number;
  running: boolean;
  lastRunAt?: string;
  nextRunAt?: string;
  lastError?: string;
  lastResult?: { opened: number; closed: number; realizedPnlUsd: number; markets?: number };
}

export interface DashboardOptions {
  ledgerPath: string;
  rulesPath: string;
  demo: boolean;
  getLoop?: () => LoopState;
  getEvents?: () => EngineEvent[];
}

function slimPosition(p: PaperPosition) {
  return {
    id: p.id,
    ruleId: p.ruleId,
    platform: p.platform,
    marketId: p.marketId,
    title: p.title,
    url: p.url,
    side: p.side,
    status: p.status,
    entryAt: p.entryAt,
    entryPrice: p.entryPrice,
    contracts: p.contracts,
    costUsd: p.costUsd,
    entryFeeUsd: p.entryFeeUsd,
    lastMarkPrice: p.lastMarkPrice,
    lastMarkAt: p.lastMarkAt,
    marketStatus: p.marketStatus,
    unrealizedPnlUsd: p.unrealizedPnlUsd,
    exitAt: p.exitAt,
    exitPrice: p.exitPrice,
    exitReason: p.exitReason,
    exitDetail: p.exitDetail,
    realizedPnlUsd: p.realizedPnlUsd,
  };
}

export async function buildState(opts: DashboardOptions) {
  const now = new Date();
  const fileInfo = await stat(opts.ledgerPath).catch(() => null);
  const ledger = await loadLedger(opts.ledgerPath, { demo: opts.demo });
  const summary = summarizeLedger(ledger);

  let ruleMeta = new Map<string, { name: string; action: string; enabled: boolean }>();
  let rulesError: string | undefined;
  try {
    const file = await loadRulesFile(opts.rulesPath);
    ruleMeta = new Map(file.rules.map((r) => [r.id, { name: r.name, action: r.action, enabled: r.enabled }]));
  } catch (err) {
    rulesError = (err as Error).message;
  }

  // Every paper rule appears, even before its first trade.
  const byId = new Map(summary.rules.map((s) => [s.ruleId, s]));
  for (const [id, meta] of ruleMeta) {
    if (!byId.has(id) && meta.enabled && meta.action !== "alert") {
      byId.set(id, {
        ruleId: id,
        open: 0,
        exposureUsd: 0,
        unrealizedPnlUsd: 0,
        closed: 0,
        wins: 0,
        losses: 0,
        realizedPnlUsd: 0,
        feesUsd: 0,
        consecutiveLosses: ledger.ruleState[id]?.consecutiveLosses ?? 0,
        pausedUntil: ledger.ruleState[id]?.pausedUntil,
      });
    }
  }
  const rules = [...byId.values()]
    .map((s) => ({ ...s, ...(ruleMeta.get(s.ruleId) ?? { name: s.ruleId, action: "unknown", enabled: false }) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const open = ledger.positions
    .filter((p) => p.status === "open")
    .sort((a, b) => b.entryAt.localeCompare(a.entryAt))
    .map(slimPosition);
  const closedAsc = ledger.positions
    .filter((p) => p.status === "closed" && p.exitAt)
    .sort((a, b) => a.exitAt!.localeCompare(b.exitAt!));

  let cum = 0;
  const pnlSeries = closedAsc.map((p) => {
    cum += p.realizedPnlUsd ?? 0;
    return {
      at: p.exitAt!,
      cumPnlUsd: Math.round(cum * 100) / 100,
      pnlUsd: p.realizedPnlUsd ?? 0,
      title: p.title,
      ruleId: p.ruleId,
    };
  });

  const journal = ledger.fills
    .filter((f) => f.kind === "open" || f.kind === "close")
    .slice(-60)
    .reverse()
    .map((f) => ({
      at: f.at,
      kind: f.kind,
      ruleId: f.ruleId,
      title: f.title,
      side: f.side,
      price: f.price,
      sizeUsd: f.sizeUsd,
      pnlUsd: f.pnlUsd,
      reason: f.reason,
    }));

  return {
    ok: true as const,
    now: now.toISOString(),
    hypothetical: true,
    ledger: {
      path: opts.ledgerPath,
      demo: ledger.demo,
      exists: fileInfo != null,
      updatedAt: fileInfo?.mtime.toISOString(),
      createdAt: ledger.createdAt,
      migratedFromV1: ledger.migratedFromV1,
    },
    totals: summary.total,
    rules,
    /** Display names for every rule, including alert-only ones (used by the alert feed). */
    ruleNames: Object.fromEntries([...ruleMeta].map(([id, m]) => [id, m.name])),
    rulesError,
    open,
    closed: closedAsc.slice(-100).reverse().map(slimPosition),
    pnlSeries,
    journal,
    loop: opts.getLoop?.() ?? { enabled: false, running: false },
    events: (opts.getEvents?.() ?? []).slice(-80).reverse(),
  };
}

let pageCache: string | undefined;
async function page(): Promise<string> {
  if (pageCache && process.env.NODE_ENV === "production") return pageCache;
  for (const p of PAGE_CANDIDATES) {
    try {
      pageCache = await readFile(p, "utf8");
      return pageCache;
    } catch {
      // try next
    }
  }
  throw new Error("dashboard index.html not found");
}

const SECURITY_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy":
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
};

/** Only answer requests addressed to this machine (blocks DNS-rebinding reads from other sites). */
function hostAllowed(host: string | undefined): boolean {
  if (!host) return false;
  const name = host.replace(/:\d+$/, "").replace(/^\[|\]$/g, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "::1";
}

export function createDashboardServer(opts: DashboardOptions): http.Server {
  return http.createServer(async (req, res) => {
    try {
      if (!hostAllowed(req.headers.host)) {
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
        return;
      }
      if (req.method !== "GET" && req.method !== "HEAD") {
        res.writeHead(405, { Allow: "GET, HEAD", "Content-Type": "text/plain" }).end("Read-only dashboard");
        return;
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      if (url.pathname === "/" || url.pathname === "/index.html") {
        res.writeHead(200, { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : await page());
        return;
      }
      if (url.pathname === "/api/state") {
        let body: unknown;
        let status = 200;
        try {
          body = await buildState(opts);
        } catch (err) {
          status = 500;
          body = { ok: false, error: (err as Error).message, loop: opts.getLoop?.() };
        }
        res.writeHead(status, { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8" });
        res.end(req.method === "HEAD" ? undefined : JSON.stringify(body));
        return;
      }
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
    } catch (err) {
      if (!res.headersSent) res.writeHead(500, { "Content-Type": "text/plain" });
      res.end(`Error: ${(err as Error).message}`);
    }
  });
}
