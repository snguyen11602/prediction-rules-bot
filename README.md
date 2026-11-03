# prediction-rules-bot

Shared **rules engine** for **Kalshi** and **Polymarket US** (global Polymarket is still supported). Run locally alongside Claude / Cursor / Grok Bot: edit YAML rules, scan public markets, get alerts. Paper trading writes a local ledger. **Live trading is stubbed and gated** — nothing places real orders by default.

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
npm run paper:watch   # paper trade every 5 min + live dashboard at http://localhost:4321
npm run arb:find      # review likely Kalshi ↔ Polymarket US pairs for the arbitrage strategy
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

## Main strategy: arbitrage

Configured in the `arbitrage:` block at the top of `rules/example.yaml`. It looks for sets of
contracts that pay a guaranteed amount, and paper-buys them when they cost less than that amount
after the bid/ask spread, slippage and fees.

| Kind | When | Trade | Guaranteed payout per set |
|------|------|-------|---------------------------|
| Kalshi ↔ Polymarket US | Same question priced differently on the two sites | YES on one, NO on the other | $1 |
| Same site, NO basket | Outcomes where only one can win (the platform says so) and YES bids add up to more than $1 | NO on each outcome | $1 × (outcomes − 1) |
| Same site, YES basket | Outcomes where exactly one must win and YES asks add up to less than $1 | YES on every outcome | $1 |

- **Matching across sites** is the hard part. Pairs are found automatically only when the numbers,
  years, direction and timing words (cut/hike, above/below, before/after, "at any time"), election
  and role words (primary/general, vice), and names (in the same order) all agree, and the titles
  are similar. Even then, **auto-matched pairs only alert**: paper trades need you to confirm the
  pair (`npm run arb:find`, then `npm run arb:confirm -- <#>` or `npm run arb:block -- <#>`, saved
  in `rules/arb-pairs.yaml`). On live data this already rejects look-alikes such as "Presidential
  nominee" vs "Vice-Presidential nominee", and the same meeting question with different deadlines.
- **Kalshi coverage:** Kalshi has thousands of events and rate-limits, so each check reads one more
  page of events and matching uses a rolling cache (`data/*.arb-cache.json`). It takes about two hours
  of checks to page through everything. Matched markets are always re-priced before quoting.
- **Same-site baskets** only use the platforms' own flags: Kalshi's `mutually_exclusive` events and
  global Polymarket's neg-risk events. Polymarket US doesn't publish such a flag, so it has none. NO baskets are on. YES baskets are off by default, because neither
  site guarantees that one listed outcome must win.
- **Sizing and risk** use the same knobs as the other rules: `position_size_fraction`, `max_position_usd`,
  `max_open_positions` (counted per arb, not per leg) and the consecutive-loss pause. An arb that
  loses money means the legs didn't hedge (usually a bad match), so the default pauses after 2.
- **Exits:** each arb is held until every leg settles, or sold early (`unwind_early`) when selling every
  leg already returns the full guaranteed payout. Each arb counts as one trade in the stats.
- **Limits:** paper trading assumes the best price is available for the whole size and that both legs
  fill at once; real books are thin and prices move. Real opportunities are rare and usually a few
  cents. Live trading would also need money on both sites. From the US, only Polymarket US can open trades,
  which is why it's the default (`arbitrage.cross_platform.with`). Opportunities only need public data,
  so `npm run scan` and `npm run watch` report them as alerts.

## Copy trading (follow top traders)

Configured in the `copy_trading:` block of `rules/example.yaml`. Paper by default.

- **Who to follow.** Global Polymarket is the only exchange that publishes other traders' accounts, so
  leaders come from its public leaderboard (`data-api.polymarket.com`): the top 50 by profit this
  month, kept only if they've traded at least 50 markets and won at least 55% of their last ~200
  closed positions (30+ results). The best 10 by profit are followed; the list refreshes every 6 hours.
  `include` / `exclude` take wallets to always / never follow.
- **What gets copied.** Their new buys of $500+ from the last 30 minutes, on the same market where you
  can trade it:
  - sports: the exact game on Polymarket US (same teams and start time; the side is chosen by team name)
    and on Kalshi (its game event for the same teams and date; team names checked against Polymarket US),
  - everything else: the strict Yes/No title match used for arbitrage, on Polymarket US, then Kalshi.
  Spreads, over/unders and props aren't copied yet. Bets with no clear twin are skipped, not guessed.
- **Price.** A copy never pays more than 3¢ above the leader's price, and the two sites must agree on the
  price within 10¢ (otherwise it's probably not the same bet).
- **Which venue.** When the bet is on both Kalshi and Polymarket US, it goes to Kalshi if Kalshi costs no
  more than 1¢ extra per contract including fees (`prefer: kalshi`, `prefer_within: 0.01`), otherwise to
  the cheaper one. The trade's **Why?** shows both prices.
- **Exits.** It sells when the leader sells (`follow_sells`; a sale worth at least half of
  `min_leader_trade_usd` counts, so a partial trim closes the whole copy), when the market resolves, or at
  the stop loss. A leader's sell is remembered, so a copy that can't sell right away (no bid) sells on a
  later check, and anyone you still hold a copy from keeps being watched after they leave the leader list
  or copy trading is switched off. Sizing, caps and the losing-streak pause use the same risk block as
  every other strategy.
- **Honest limits.** You see a trade only after it happens (a minute or more later), and a big trader's
  buy often moves the price first. High win rates often come from buying heavy favorites (small wins,
  rare big losses), and a monthly leaderboard is partly luck. The dashboard lists each copied and skipped
  bet with the reason; every copied trade's **Why?** shows the leader, their bet and the price checks.

## Fast mode (live prices)

`npm run paper:fast` streams live prices over the exchanges' WebSockets and checks for paper entries and
exits every 5 seconds (`--tick`), between the normal full checks (`--interval`, default 5 minutes).
Stop-losses, take-profits and trailing stops then react within seconds instead of minutes, and copy trading
checks the leaders every minute. Still paper only.

- It needs your API keys in a local `.env` (Kalshi: `KALSHI_API_KEY_ID` + `KALSHI_PRIVATE_KEY_PATH`;
  Polymarket US: `POLYMARKET_KEY_ID` + `POLYMARKET_SECRET_KEY`). Either one is enough. Both exchanges
  require a signed connection even for price streams. The keys are only used to sign that connection;
  `src/live-data/` has no order, cancel or account code. Key contents are never logged.
- Without keys, `paper:fast` says so and runs normal checks.
- Quick checks only act on markets with a live streamed price. Everything else (no stream, stream down,
  a quiet market after a reconnect) waits for the next full check. A streamed empty book is treated as
  untradeable, never as the last REST price. Arbitrage is managed on full checks only.
- "Moved since the last check" rules still compare with the last **full** check, so a 5¢ drop since then
  is caught within seconds, not missed because the previous quick check was 5 seconds ago.
- The status line on the dashboard shows each stream (✓ live, ✗ key rejected).
- `quick-flip-paper` in the example rules is made for this mode. Round-trip fees are about 3¢ at mid
  prices, so quick flips only pay on bigger bounces; check `npm run paper:report` before trusting it.

## Unusual moves (possible informed trading)

The bot can't know who is trading or why. What it can spot in public prices is the footprint informed
traders often leave. It saves a price/volume snapshot per market on every check
(`data/*.history.json`) and flags a move when it is:

- **big:** at least `min_move` in the last `window_minutes`;
- **big for this market:** `min_zscore` × its typical change over the same span in the previous 12 hours;
- **on volume:** at least `min_volume_ratio` × its normal volume;
- **holding:** it has given back at most `max_retrace` of the move.

The rules that use it:

| Rule | What it does |
|------|--------------|
| `unusual-move-alert` | Alert only: shows up in the terminal, webhook and the dashboard's **Unusual moves** panel |
| `follow-unusual-move-paper` | Paper-buys in the direction of the move (`side: with_move`), then a trailing stop sells near the high |
| `dip-reversion-paper` | Still buys ordinary dips, but `unusual_move: { mode: exclude }` keeps it out of drops that look informed |

It needs at least 3 hours of snapshots (12 for a full baseline) before it can judge what's normal, so leave `npm run paper:watch` running. Until then, the dip rule stays out rather than guess.
News, big traders and thin order books cause the same pattern, so treat it as a lead, not proof.

## Strategy league (the bot makes its own strategies)

The bot invents strategies, names them like traders on a leaderboard ("Leo Valdez — The Trend Rider"),
and paper-trades them next to your own rules. Each one has a personality:

| Trait | What it changes |
|-------|-----------------|
| **Work ethic** | how busy it is: more trades at once, shorter breaks before re-entering a market |
| **Creativity** | how different its clones are from it |
| **Knowledge** | how many safety checks it uses: tighter spreads, timing, skipping parlays and the like |

Rookies come from five ideas: buy sharp drops (The Dip Hunter), ride sharp moves (The Trend Rider), buy
heavy favorites near the finish (The Closer), bet against long shots (The Skeptic) and flip small moves in
tight markets (The Scalper).

Once a day (`evolve_every_hours`) a **round** runs in the background while `npm run paper:watch` is running,
or now with `npm run league`:

1. **Backtest.** Everyone, including your paper rules, is replayed hour by hour over the last 14 days of real
   prices (Kalshi candlesticks and Polymarket US price history, public data, cached in `data/backtest/`). It
   uses the same engine, checks and fees as paper trading, and settles finished markets with their real result.
   Rules only see what was known at the time: prices once their hour is over, and the close time a market
   showed while it was open (not when the game really ended).
2. **Rank** by *steady score* on the first 70% of the window: profit as a % of the $1,000 bankroll minus the
   worst drop in %. Trades still open count at what they'd sell for, so holding losers doesn't help. Once a
   strategy has 10 paper trades, its paper score counts half.
3. **Clone the best.** The top 3 each get a clone with the same idea, nudged numbers and a similar
   personality. Clones keep the family surname. To count, a winner must also make money on at least 2 trades
   in the last 30% of the window (held out), so early luck doesn't get cloned.
4. **Diagnose and retire the worst** (up to 3): losing once ranked, or never trading. The diagnosis says why in
   plain words, for example *"Fees ate the edge: $60 in fees on top of $37 lost before fees"* or
   *"Never found a trade: 'Price band' ruled out 96% of the market checks"*. Rookies take their place.

The dashboard's **Leaderboard** tab ranks everyone and can sort by steady score, profit, win rate or trades,
using backtest or paper results. Click a name for its own page: personality, how it trades, its P/L chart, its
trades (backtest and paper, each with **Why?**), the coach's notes and its family. The **Backtests** tab shows
the last run and the evolution log. **Live money** is a placeholder: live trading stays off.

```bash
npm run league                 # run a round now (a few minutes)
npm run league -- --show       # print the roster
npm run league -- --days 7 --markets 40   # a quicker, smaller backtest
```

Settings are in the `league:` block of the rules file (no block = these defaults); `enabled: false` stops new
league trades (open ones are still managed). Honest limits: prices are hourly, so quick flips are only roughly
tested; Polymarket US history has no order-book depth, so liquidity filters only pass on Kalshi in a backtest;
markets are picked from finished games by how much they traded; each day's window overlaps the last, so the
held-out part is reused over time (paper results are the truly new data); and two weeks of games is a small
sample — a winner is a hypothesis, not a proven edge.

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
Polymarket US charges `Θ × contracts × P × (1 − P)` with the market's `feeCoefficient` (Θ = 0.0695 on most
markets), rounded to the cent, and trades in steps of the market's `minimumTradeQty` (0.01 or 1 contract).
Global Polymarket uses its published fee schedule with fractional shares. Settlement has no fee. The bankroll gate
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

### Dashboard

```bash
npm run paper:watch          # trades every 5 minutes and opens http://localhost:4321
npm run dashboard            # just the dashboard (read-only), if paper runs elsewhere (cron, --loop)
npm run paper:watch -- --demo --fixture fixtures/markets.later.json   # try it on demo data
```

Tabs: **Paper trading** (below), **Leaderboard** and **Backtests** (see Strategy league), and **Live
money** (off). The page refreshes every 5 seconds. It shows total, closed-trade and open-trade profit/loss, win rate,
a chart of closed-trade profit/loss over time, each strategy (including loss-streak pauses), open and
closed trades, and new alerts. It only listens on `127.0.0.1`, is read-only, and warns you when paper
trading has stopped. Flags: `--port N`, `--interval sec`, `--no-open`. Ctrl+C finishes the current check
and exits. Don't run `paper:watch` and `paper -- --loop` at the same time; the second one just waits
for the lock.

**How the bot decides.** While `paper:watch` runs, the top of the page shows the last check as a
funnel: every market × strategy → passed filters → entry signal → position OK → risk OK → traded or
alerted. A replay strip steps through that check market by market and shows where each one dropped
out (▶ Replay last scan to run it again). A per-strategy table lists the check that drops the most
markets, and "Signals this check" lists every trade, alert, risk block, and near miss.

Every trade has a **Why?** button. It opens the full checklist the bot passed for that trade, with
the real numbers (for example "YES 89.5¢ is within 85–95¢" or "5% of $1,000, capped at $50 = $50"),
the paper fill, and what has happened since. The engine records these checks from the same code
that makes the decision (`src/engine/trace.ts`), so the dashboard can't drift from what the bot actually did.
Trades opened before this version have no checklist.

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
| `entry` | `unusual_move` | `mode: require` / `exclude` plus thresholds (see Unusual moves) |
| `entry` | `side: with_move` / `against_move` | Buy in / against the direction of the move |
| `exit` | `trailing_stop`, `trailing_activation` | Sell when the price falls this far from its best since entry, once it's been this far in profit |
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
- `KALSHI_API_BASE` / `POLYMARKET_US_BASE` / `POLYMARKET_GAMMA_BASE` — override public bases
- `POLYMARKET_US_BOOKS` — Polymarket US order books read per scan for liquidity (default 100)
- `KALSHI_API_KEY_ID`, `KALSHI_PRIVATE_KEY_PATH`, `POLYMARKET_KEY_ID`, `POLYMARKET_SECRET_KEY` — only for
  `npm run paper:fast` (read-only price streams); keep them in `.env`, never in git

## Layout

```
rules/                 YAML rule configs
fixtures/              Offline markets for --demo (markets.json, markets.later.json)
src/rules/             Shared Zod schema + loader
src/platforms/         Kalshi, Polymarket US and global Polymarket adapters (+ demo)
src/engine/            Evaluate, exits, pricing, risk, runner, paper session, events
src/ledger/            Paper ledger: positions, fills journal, PnL (JSON)
src/league/            Strategy league: personas, strategy DNA, scoring, diagnosis, evolution
src/backtest/          Price history (cached), replay adapter, backtest runner
src/cli/               scan | watch | paper | paper-report | league | live
AGENTS.md              How to extend without breaking the schema
```

## Platform notes

### Kalshi (public read)

- Base used here: `https://api.elections.kalshi.com/trade-api/v2`
- Example: `GET /markets?status=open&limit=100&mve_filter=exclude`
- Some hosts (e.g. `external-api.kalshi.com`) may 403 from certain networks — override with `KALSHI_API_BASE` or use `--demo`.
- **Trading / portfolio** endpoints need API key ID + RSA private key signing (documented by Kalshi; not wired in this starter).

### Polymarket US (public read) — platform id `polymarket_us`, the default

Polymarket US (polymarket.us) is a separate exchange from global Polymarket, with its own markets and
prices. It's the one US residents can trade; the global site is close-only from the US.

- Public gateway: `https://gateway.polymarket.us` — `GET /v1/markets` (most-traded first),
  `/v1/market/id/{id}`, `/v1/markets/{slug}/book`, `/v1/markets/{slug}/settlement`. No key needed.
- Each market is one YES/NO contract. YES is the market's "long" side; two-sided markets (team vs
  team, over/under) say which side is YES in the title, e.g. `… [YES = Seoul SK Knights]`.
- **Liquidity** comes from the order book (resting orders within 10¢ of the mid) for the first 100
  markets of each scan. **24h volume isn't published**: the 24h-volume filter is skipped for these
  markets and the checklist says so (spread and liquidity still apply). A market with no trade in
  24h counts as 0 volume. Unusual-move signals need volume, so they rarely fire here.
- Close times are the market's `endDate`, which is often the settlement deadline (weeks after the
  game or election), so time-to-resolve filters see them as further away than they are.
- Results come from the settlement endpoint once the market is `RESOLVED`, never from prices.
- No public flag says which events are "only one can win", so there's no same-site arbitrage here.
- **Live trading** later: Key ID + Secret Key from polymarket.us/developer (Ed25519 signing) — not
  used by this bot.

Pick the Polymarket for arbitrage with `arbitrage.cross_platform.with: polymarket_us | polymarket`.
Pairs in `rules/arb-pairs.yaml` carry `platform:` (`arb:confirm` writes it; old pairs without it are global).

### Polymarket global (public read) — platform id `polymarket`

- Gamma discovery: `https://gamma-api.polymarket.com/markets?closed=false&active=true`
- CLOB book/price reads: `https://clob.polymarket.com` (optional; listing uses Gamma)
- Add `polymarket` to a rule's `platforms` to scan it. Paper positions opened there before
  Polymarket US support keep being priced and closed on the global site.

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
