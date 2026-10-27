# prediction-rules-bot

Shared **rules engine** for **Kalshi** and **Polymarket**. Run locally alongside Claude / Cursor / Grok Bot: edit YAML rules, scan public markets, get alerts. Paper trading writes a local ledger. **Live trading is stubbed and gated** — nothing places real orders by default.

## Quick start

```bash
cd prediction-rules-bot
npm install
npm run scan          # one-shot alerts from public APIs (no keys)
npm run scan -- --demo   # if an API is down / blocked — uses fixtures/
npm run watch         # poll on an interval; alerts when a market starts matching
npm run paper         # marks/exits open paper positions, then paper-enters new signals
npm run paper:report  # offline PnL report from the paper ledger
npm run paper:close -- --id <id> --price <0-1>   # manually close a stuck paper position
npm test              # unit + demo end-to-end tests (no network)
npm run live          # exits with “not implemented / needs keys”
```

Node 20+ recommended. Uses `tsx` so you don’t need a build step for day-to-day runs.

## What it does

1. Loads rules from `rules/*.yaml` (shared schema for both platforms).
2. Fetches open markets via **public** adapters (no API keys for alert/paper).
3. Evaluates filters + entry conditions + risk gates.
4. Emits events to the console (optional webhook / JSONL file).
5. In paper mode, also manages hypothetical positions in a local ledger (below).

## Paper trading

Each `npm run paper` is one cycle against the ledger:

1. **Mark & exit** every open position. Markets that dropped out of the listing are re-read by id
   (public endpoint). Resolved markets settle at their payout (1.00 / 0.00, or a split / scalar
   value when the platform reports one); otherwise the rule's `exit` block is checked (stop loss →
   take profit → time to resolve → max hold) and the position is sold at the bid. If the held side
   has **no bid** (empty book), the position is held and marked at the mid — it is never sold at 0.
   Closed-but-unresolved and disputed markets are held until they settle.
2. **Risk bookkeeping**: realized PnL feeds the consecutive-loss counter. After
   `fire_after_n_losses` straight losses the rule pauses for `pause_hours_after_losses`.
   Streaks and pauses persist in the ledger across runs.
3. **Entries** for rules with `action: paper` (use `--paper-all` to paper every rule). Markets the rule
   already holds, or exited within `reentry_cooldown_hours`, are skipped. Entries are blocked when they
   would exceed `bankroll_usd` + realized PnL.

Fill realism: buys pay the ask, sells hit the bid (NO quotes are the complement of YES quotes), plus
optional `paper.slippage`. Empty book sides (bid 0 / ask 1) are treated as no quote. Kalshi fills are
whole contracts and include an *approximate* taker fee (`0.07 × contracts × P × (1 − P)`, rounded up);
Polymarket is modelled fee-free with fractional shares. Settlement has no fee. The bankroll gate
counts open cost basis; entry fees show up in unrealized, then realized, PnL.

Ledger: `data/paper-ledger.json` (`data/paper-ledger.demo.json` with `--demo`; the two never mix).
It holds `positions` (entry, marks, exit, realized/unrealized PnL), an append-only `fills` journal,
per-rule `ruleState`, and `lastPrices` so move-based rules work across runs. Writes are atomic
(fsync + rename). A lock file stops overlapping runs; a lock left by a crashed or killed run is taken
over automatically once its process is gone.

v1 ledgers (written by the old `paper` command, which mixed `--demo` and real fills and re-bought the
same markets every run) are upgraded with their fills kept in the journal for reference, but **no
positions are opened from them** — the v2 book starts flat.

Run it on a schedule (cron) or keep it running with `npm run paper -- --loop --interval 300`
(Ctrl+C finishes the current cycle, then exits). Positions that can never settle on their own (voided
markets, payouts the adapter can't read) can be closed with
`npm run paper:close -- --id <id from paper:report> --price <held-side value>`; manual closes record
PnL but don't change the loss streak.

### Try the full flow offline

```bash
npm run paper -- --demo                                        # opens 4 paper positions
npm run paper -- --demo                                        # same prices: no duplicate buys
npm run paper -- --demo --fixture fixtures/markets.later.json  # TP, 2× stop loss, 1 resolution,
                                                               # loss pause trips, 1 dip entry
                                                               # (realized −$29.06, fees $1.43)
npm run paper:report -- --demo
rm data/paper-ledger.demo.json                                 # reset the demo
```

Example risk knobs in `rules/example.yaml`:

- `position_size_fraction: 0.25` — size new ideas at 25% of assumed bankroll
- `fire_after_n_losses: 3` — pause new entries after 3 consecutive losses
- `daily_loss_cap_usd`, `max_open_positions`, `max_position_usd`, `reentry_cooldown_hours`

Example rules: three alert watchlists (contested politics, short-dated price moves, macro/econ) and
three paper strategies to evaluate (YES favorites and NO-on-longshots held to resolution, and dip
reversion in liquid markets). The paper strategies are hypotheses, not proven edges.

### Rule fields added in this version (all optional)

| Section | Field | Meaning |
|---------|-------|---------|
| `filters` | `min_volume_24h_usd` | Skip markets without enough 24h volume |
| `filters` | `max_spread` | Max YES bid/ask spread; markets without quotes fail |
| `entry` | `move_direction` | `up` / `down` / `any` (default) for the move conditions |
| `entry` | `max_prior_age_minutes` | Ignore the previous observation if it is older than this |
| `exit` | `take_profit_pct`, `stop_loss_pct` | Return vs entry price |
| `exit` | `max_hold_hours` | Time stop |
| `risk` | `reentry_cooldown_hours` | Default 24 |
| `paper` | `slippage`, `include_fees` | Fill realism (defaults 0 / true) |

Exit prices (`take_profit_price`, `stop_loss_price`) are for the contract you **hold**: the YES price
for `side: yes`, the NO price for `side: no`.

## Safety

| Mode | Places real orders? | Needs keys? |
|------|---------------------|-------------|
| `scan` / `watch` | No | No |
| `paper` / `paper:report` | No (local JSON ledger) | No |
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
fixtures/              Offline markets for --demo (markets.json, markets.later.json)
src/rules/             Shared Zod schema + loader
src/platforms/         Kalshi + Polymarket adapters (+ demo)
src/engine/            Evaluate, exits, pricing, risk, runner, paper session, events
src/ledger/            Paper ledger: positions, fills journal, PnL (JSON)
src/cli/               scan | watch | paper | paper-report | live
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
--fixture <path>    With --demo: alternate fixture snapshot (e.g. fixtures/markets.later.json)
--rules <path>      Rules file (default rules/example.yaml)
--limit <n>         Max markets per platform (default 80)
--interval <sec>    Watch / paper --loop poll interval
--log-file <path>   Append JSONL events
--webhook <url>     POST each event as JSON
--ledger <path>     Paper ledger file
--paper-all         Paper every enabled rule, not only action: paper
--loop              Paper: repeat every --interval seconds
--json              paper:report: machine-readable output
--id <id> --price p paper:close: position id (prefix ok) and held-side exit price
```

Unknown flags exit with an error instead of being ignored.

## Extending

Read **AGENTS.md** before changing the schema or adapters. Prefer new optional YAML fields and new adapter methods over breaking `NormalizedMarket` or `RuleSchema`.
