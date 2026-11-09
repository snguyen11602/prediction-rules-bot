import type { EngineEvent } from "../types.js";
import type { EventSink } from "./events.js";

/**
 * Phone alerts: short messages to a chat webhook (Discord, Slack, ntfy, Telegram or anything that
 * takes JSON). The URL is a secret: it comes from `.env` (ALERT_WEBHOOK_URL), is never logged, and
 * nothing but the alert text is sent to it. Every message says PAPER: nothing here is a real trade.
 */

export type AlertKind = "trades" | "exits" | "pauses" | "signals" | "problems";
export const DEFAULT_ALERT_KINDS: AlertKind[] = ["trades", "exits", "pauses"];
const ALL_KINDS: AlertKind[] = ["trades", "exits", "pauses", "signals", "problems"];

export function alertKind(e: EngineEvent): AlertKind | undefined {
  switch (e.type) {
    case "paper_fill":
    case "arb_open":
      return "trades";
    case "paper_exit":
    case "arb_close":
      return "exits";
    case "risk_block":
      return /pause armed/i.test(e.message) ? "pauses" : undefined;
    case "entry_signal":
    case "arb_signal":
      return "signals";
    case "adapter_error":
      return "problems";
    default:
      return undefined;
  }
}

const LABEL: Record<AlertKind, string> = { trades: "PAPER TRADE", exits: "PAPER EXIT", pauses: "PAUSED", signals: "SIGNAL", problems: "PROBLEM" };

export function alertText(e: EngineEvent, kind: AlertKind): string {
  const title = e.market?.title && !e.message.includes(e.market.title) ? ` — ${e.market.title}` : "";
  return `${LABEL[kind]}${e.ruleId ? ` · ${e.ruleId}` : ""}\n${e.message}${title}`.slice(0, 1800);
}

/** The request each kind of webhook expects. */
export function alertRequest(url: string, text: string): { headers: Record<string, string>; body: string } {
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    // an unparseable URL fails at fetch time; nothing to shape here
  }
  if (/(^|\.)ntfy\./.test(host) || host === "ntfy.sh") return { headers: { "Content-Type": "text/plain; charset=utf-8", Title: "Prediction bot (paper)" }, body: text };
  const json = { "Content-Type": "application/json" };
  if (/discord(app)?\.com$/.test(host)) return { headers: json, body: JSON.stringify({ content: text }) };
  if (host === "hooks.slack.com") return { headers: json, body: JSON.stringify({ text }) };
  return { headers: json, body: JSON.stringify({ text, content: text }) };
}

export interface AlertOptions {
  kinds?: AlertKind[];
  /** Only these rule ids (empty = all). */
  rules?: string[];
  /** At most this many messages per 10 minutes; the rest are counted and mentioned in the next one. */
  maxPer10Min?: number;
  now?: () => number;
  post?: (url: string, init: { method: "POST"; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number }>;
  onError?: (message: string) => void;
}

export function parseAlertKinds(raw: string | undefined): AlertKind[] {
  if (!raw?.trim()) return DEFAULT_ALERT_KINDS;
  const want = raw.split(",").map((s) => s.trim().toLowerCase());
  if (want.includes("all")) return ALL_KINDS;
  const kinds = ALL_KINDS.filter((k) => want.includes(k));
  return kinds.length ? kinds : DEFAULT_ALERT_KINDS;
}

export function alertSink(url: string, opts: AlertOptions = {}): EventSink {
  const kinds = new Set(opts.kinds ?? DEFAULT_ALERT_KINDS);
  const rules = new Set(opts.rules ?? []);
  const max = opts.maxPer10Min ?? 15;
  const now = opts.now ?? Date.now;
  const post = opts.post ?? ((u, init) => fetch(u, { ...init, signal: AbortSignal.timeout(10_000) }));
  const sent: number[] = [];
  let dropped = 0;
  return async (event) => {
    const kind = alertKind(event);
    if (!kind || !kinds.has(kind)) return;
    if (rules.size && (!event.ruleId || !rules.has(event.ruleId))) return;
    const t = now();
    while (sent.length && t - sent[0] > 600_000) sent.shift();
    if (sent.length >= max) {
      dropped += 1;
      return;
    }
    sent.push(t);
    let text = alertText(event, kind);
    if (dropped) {
      text += `\n(+${dropped} earlier alert${dropped === 1 ? "" : "s"} not sent: too many at once)`;
      dropped = 0;
    }
    try {
      const res = await post(url, { method: "POST", ...alertRequest(url, text) });
      if (!res.ok) (opts.onError ?? console.error)(`Phone alert not delivered (HTTP ${res.status}). Check ALERT_WEBHOOK_URL in .env.`);
    } catch {
      // Never print the error itself: it can contain the webhook URL.
      (opts.onError ?? console.error)("Phone alert not delivered (network error).");
    }
  };
}

/** The alert sink configured in the environment, if any. */
export function alertSinkFromEnv(env: NodeJS.ProcessEnv = process.env): EventSink | undefined {
  const url = env.ALERT_WEBHOOK_URL?.trim();
  if (!url || !/^https?:\/\//.test(url)) return undefined;
  return alertSink(url, { kinds: parseAlertKinds(env.ALERT_EVENTS), rules: env.ALERT_RULES?.split(",").map((s) => s.trim()).filter(Boolean) });
}
