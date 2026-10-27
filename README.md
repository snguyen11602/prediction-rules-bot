# prediction-rules-bot

Shared **rules engine** for **Kalshi** and **Polymarket**. Run locally alongside Claude / Cursor / Grok Bot: edit YAML rules, scan public markets, get alerts. Paper trading writes a local ledger. **Live trading is stubbed and gated** — nothing places real orders by default.

## Quick start

```bash
cd prediction-rules-bot
npm install
npm run scan          # one-shot alerts from public APIs (no keys)
npm run scan -- --demo   # if an API is down / blocked — uses fixtures/
npm run watch         # poll on an interval
npm run paper         # same scan + hypothetical fills → data/paper-ledger.json
npm run live          # exits with “not implemented / needs keys”
```

Node 20+ recommended. Uses `tsx` so you don’t need a build step for day-to-day runs.

## What it does

1. Loads rules from `rules/*.yaml` (shared schema for both platforms).
2. Fetches open markets via **public** adapters (no API keys for alert/paper).
3. Evaluates filters + entry conditions + risk gates.
4. Emits events to the console (optional webhook / JSONL file).

Example risk knobs in `rules/example.yaml`:

- `position_size_fraction: 0.25` — size new ideas at 25% of assumed bankroll
- `fire_after_n_losses: 3` — pause new entries after 3 consecutive losses
- `daily_loss_cap_usd`, `max_open_positions`, `max_position_usd`

## Safety

| Mode | Places real orders? | Needs keys? |
|------|---------------------|-------------|
| `scan` / `watch` | No | No |
| `paper` | No (local JSON ledger) | No |
| `live` | **Not implemented** | Would need keys + env gates |

Live would require **all** of: `ENABLE_LIVE_TRADING=true`, `ALLOW_LIVE=true`, and CLI `--i-understand-live`. Even then, this repo’s `npm run live` only prints a refusal — there is **no** order-placement code path that can fire from scan/watch/paper.

## Env vars

See `.env.example`. Nothing is required for public scans.

Optional:

- `POLL_INTERVAL_SEC` — watch interval (default 60)
- `WEBHOOK_URL` / `EVENT_LOG_FILE` — extra event sinks
- `KALSHI_API_BASE` / `POLYMARKET_GAMMA_BASE` — override public bases

## Layout

```
rules/                 YAML rule configs
fixtures/              Offline markets for --demo
src/rules/             Shared Zod schema + loader
src/platforms/         Kalshi + Polymarket adapters (+ demo)
src/engine/            Evaluate, risk, runner, events
src/ledger/            Paper fills (JSON)
src/cli/               scan | watch | paper | live
AGENTS.md              How to extend without breaking the schema
```

## Platform notes

### Kalshi (public read)

- Base used here: `https://api.elections.kalshi.com/trade-api/v2`
- Example: `GET /markets?status=open&limit=100&mve_filter=exclude`
- Some hosts (e.g. `external-api.kalshi.com`) may 403 from certain networks — override with `KALSHI_API_BASE` or use `--demo`.
- **Trading / portfolio** endpoints need API key ID + RSA private key signing (documented by Kalshi; not wired in this starter).

### Polymarket (public read)

- Gamma discovery: `https://gamma-api.polymarket.com/markets?closed=false&active=true`
- CLOB book/price reads: `https://clob.polymarket.com` (optional; listing uses Gamma)
- **Live trading** later: L1 wallet signature + L2 HMAC API credentials — not required for alerts.

## CLI flags

```
--demo              Use fixtures instead of live HTTP
--rules <path>      Rules file (default rules/example.yaml)
--limit <n>         Max markets per platform (default 80)
--interval <sec>    Watch poll interval
--log-file <path>   Append JSONL events
--webhook <url>     POST each event as JSON
```

## Extending

Read **AGENTS.md** before changing the schema or adapters. Prefer new optional YAML fields and new adapter methods over breaking `NormalizedMarket` or `RuleSchema`.
