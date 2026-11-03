import WebSocket from "ws";
import type { KeyObject } from "node:crypto";
import { KALSHI_WS_PATH, POLYMARKET_US_WS_PATH, kalshiWsHeaders, polymarketUsHeaders } from "./signing.js";
import { QuoteBook, streamPrice } from "./quotes.js";
import type { PlatformId } from "../types.js";

/**
 * Read-only market-data streams. These sockets only subscribe to public price channels;
 * there is no order, cancel or account code here. API keys are used only to sign the
 * handshake (both exchanges require it for streaming).
 */

export type StreamState = "off" | "connecting" | "live" | "retrying" | "auth_failed";

export interface StreamStatus {
  platform: PlatformId;
  state: StreamState;
  markets: number;
  updates: number;
  lastMessageAt?: string;
  error?: string;
}

interface StreamOptions {
  url?: string;
  /** Reconnect when nothing arrives for this long (both exchanges heartbeat well inside it). */
  idleMs?: number;
  log?: (msg: string) => void;
}

/** Close a socket without its late events (an error from closing mid-handshake) reaching anyone. */
function kill(ws: WebSocket | undefined): void {
  if (!ws) return;
  ws.removeAllListeners();
  ws.on("error", () => undefined);
  ws.terminate();
}

abstract class MarketStream {
  protected ws?: WebSocket;
  protected wanted: string[] = [];
  protected subscribed = new Set<string>();
  private retries = 0;
  private timer?: NodeJS.Timeout;
  private idle?: NodeJS.Timeout;
  private stopped = true;
  status: StreamStatus;

  constructor(
    readonly platform: PlatformId,
    protected readonly quotes: QuoteBook,
    protected readonly opts: StreamOptions,
  ) {
    this.status = { platform, state: "off", markets: 0, updates: 0 };
  }

  protected abstract url(): string;
  protected abstract headers(): Record<string, string>;
  protected abstract subscribeMessages(ids: string[]): unknown[];
  protected abstract onMessage(msg: unknown): void;

  /** Market ids to watch. Resubscribes (by reconnecting) only when new ids appear. */
  setMarkets(ids: string[]): void {
    const next = [...new Set(ids)].filter(Boolean);
    const added = next.some((id) => !this.subscribed.has(id));
    this.wanted = next;
    this.status.markets = next.length;
    if (this.stopped) return;
    if (!this.ws) this.connect();
    else if (added) this.restart();
  }

  start(): void {
    this.stopped = false;
    if (this.wanted.length) this.connect();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.timer);
    clearTimeout(this.idle);
    kill(this.ws);
    this.ws = undefined;
    this.status.state = "off";
  }

  private restart(): void {
    kill(this.ws);
    this.ws = undefined;
    this.connect();
  }

  private touch(): void {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.opts.log?.(`${this.platform}: no data for ${Math.round((this.opts.idleMs ?? 45_000) / 1000)}s, reconnecting`);
      this.restart();
    }, this.opts.idleMs ?? 45_000);
  }

  protected connect(): void {
    if (this.stopped || !this.wanted.length) return;
    this.status.state = this.retries ? "retrying" : "connecting";
    let ws: WebSocket;
    try {
      // Fresh signature on every (re)connect: the timestamp must be current.
      ws = new WebSocket(this.url(), { headers: this.headers(), handshakeTimeout: 15_000 });
    } catch (err) {
      this.fail((err as Error).message);
      return;
    }
    this.ws = ws;
    const ids = [...this.wanted];
    ws.on("open", () => {
      this.retries = 0;
      this.status.state = "live";
      this.status.error = undefined;
      this.subscribed = new Set(ids);
      for (const m of this.subscribeMessages(ids)) ws.send(JSON.stringify(m));
      this.touch();
    });
    ws.on("ping", () => this.touch()); // ws answers pings automatically
    ws.on("message", (data) => {
      this.touch();
      this.status.lastMessageAt = new Date().toISOString();
      let msg: unknown;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.onMessage(msg);
    });
    ws.on("unexpected-response", (_req, res) => {
      const code = res.statusCode ?? 0;
      res.resume();
      if (code === 401 || code === 403) {
        // Wrong keys won't fix themselves; stop retrying and say so.
        this.status.state = "auth_failed";
        this.status.error = `the exchange rejected the API key (HTTP ${code}) — check the key in .env`;
        this.opts.log?.(`${this.platform}: ${this.status.error}`);
        this.stopped = true;
        kill(ws);
        this.ws = undefined;
        return;
      }
      this.fail(`HTTP ${code}`);
    });
    ws.on("error", (err) => this.fail(err.message));
    ws.on("close", () => this.fail("connection closed"));
  }

  private fail(reason: string): void {
    if (this.stopped) return;
    kill(this.ws);
    this.ws = undefined;
    this.subscribed.clear();
    clearTimeout(this.idle);
    this.retries += 1;
    this.status.state = "retrying";
    this.status.error = reason;
    const wait = Math.min(60_000, 1000 * 2 ** Math.min(this.retries, 6));
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.connect(), wait);
  }

  protected bump(): void {
    this.status.updates += 1;
  }
}

/** Kalshi `ticker` channel: best YES bid/ask (dollars) per market ticker. */
export class KalshiStream extends MarketStream {
  constructor(
    quotes: QuoteBook,
    private readonly creds: { keyId: string; key: KeyObject },
    opts: StreamOptions = {},
  ) {
    super("kalshi", quotes, opts);
  }

  protected url(): string {
    return this.opts.url ?? `wss://api.elections.kalshi.com${KALSHI_WS_PATH}`;
  }

  protected headers(): Record<string, string> {
    return kalshiWsHeaders(this.creds.keyId, this.creds.key);
  }

  protected subscribeMessages(ids: string[]): unknown[] {
    // One subscription for every ticker (a second "ticker" subscription can be refused as a duplicate).
    return [{ id: 1, cmd: "subscribe", params: { channels: ["ticker"], market_tickers: ids } }];
  }

  protected onMessage(raw: unknown): void {
    const m = raw as { type?: string; msg?: Record<string, unknown> };
    if (m?.type === "error") {
      this.status.error = `Kalshi stream error: ${JSON.stringify(m.msg ?? {}).slice(0, 160)}`;
      return;
    }
    if (m?.type !== "ticker" || !m.msg) return;
    const ticker = m.msg.market_ticker;
    if (typeof ticker !== "string") return;
    this.quotes.set("kalshi", ticker, {
      bid: streamPrice(m.msg.yes_bid_dollars),
      ask: streamPrice(m.msg.yes_ask_dollars),
      last: streamPrice(m.msg.price_dollars),
    });
    this.bump();
  }
}

/**
 * Polymarket US `SUBSCRIPTION_TYPE_MARKET_DATA_LITE`: best bid/ask of the long (YES) side,
 * keyed by market slug. `idForSlug` maps slugs back to market ids.
 */
export class PolymarketUsStream extends MarketStream {
  private readonly slugToId = new Map<string, string>();

  constructor(
    quotes: QuoteBook,
    private readonly creds: { keyId: string; key: KeyObject },
    opts: StreamOptions = {},
  ) {
    super("polymarket_us", quotes, opts);
  }

  /** Watch these markets: ids are market ids, slugs are what the socket subscribes with. */
  setSlugs(markets: Array<{ id: string; slug: string }>): void {
    for (const m of markets) this.slugToId.set(m.slug, m.id);
    this.setMarkets(markets.map((m) => m.slug));
  }

  protected url(): string {
    return this.opts.url ?? `wss://api.polymarket.us${POLYMARKET_US_WS_PATH}`;
  }

  protected headers(): Record<string, string> {
    return polymarketUsHeaders(this.creds.keyId, this.creds.key, "GET", POLYMARKET_US_WS_PATH);
  }

  protected subscribeMessages(slugs: string[]): unknown[] {
    const out: unknown[] = [];
    // At most 100 markets per subscription.
    for (let i = 0; i < slugs.length; i += 100) {
      out.push({
        subscribe: {
          requestId: `bbo-${i / 100}`,
          subscriptionType: "SUBSCRIPTION_TYPE_MARKET_DATA_LITE",
          marketSlugs: slugs.slice(i, i + 100),
        },
      });
    }
    return out;
  }

  protected onMessage(raw: unknown): void {
    const m = raw as { error?: unknown; marketDataLite?: Record<string, unknown> };
    if (m?.error) {
      this.status.error = `Polymarket US stream error: ${JSON.stringify(m.error).slice(0, 160)}`;
      return;
    }
    const d = m?.marketDataLite;
    if (!d || typeof d.marketSlug !== "string") return;
    const id = this.slugToId.get(d.marketSlug);
    if (!id) return;
    const px = (a: unknown) => streamPrice((a as { value?: unknown } | undefined)?.value);
    this.quotes.set("polymarket_us", id, { bid: px(d.bestBid), ask: px(d.bestAsk), last: px(d.lastTradePx) });
    this.bump();
  }
}

export type AnyStream = KalshiStream | PolymarketUsStream;
