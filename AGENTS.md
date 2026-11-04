# AGENTS.md — extending prediction-rules-bot

Guidance for Claude, Cursor, Grok Bot, or any assistant continuing this repo.

## Goals

- Keep **one shared rule schema** for Kalshi, Polymarket US (`polymarket_us`, the default) and global Polymarket (`polymarket`).
- Prefer **alerts / paper**; never add accidental live order placement.
- Preserve `npm run scan` (and `--demo`) working **without API keys**.

## Do / don’t

| Do | Don’t |
|----|--------|
| Add optional fields to Zod schemas with defaults | Rename/remove required rule fields without a migration note |
| Put platform quirks inside `src/platforms/*` | Branch on `kalshi`/`polymarket` inside evaluate/risk |
| Gate any future live code behind env **and** CLI flags | Call trading endpoints from `scan` / `watch` / `paper` |
| Degrade to clear errors + suggest `--demo` | Crash the whole process on one adapter failure |
| Document new env vars in `.env.example` + README | Commit secrets, keys, or `.env` |

## Shared contracts

1. **`NormalizedMarket`** (`src/types.ts`) — adapters must map into this. Add optional fields only.
2. **`RuleSchema`** (`src/rules/schema.ts`) — YAML/JSON rules parse through Zod. Bump `version` in `RulesFileSchema` if you make a breaking change; keep `version: 1` compatible when possible.
3. **`PlatformAdapter.listMarkets`** — public reads only. Optional `getMarket(id)` (public read, may return closed/resolved markets) and `estimateTakerFeeUsd` (paper PnL only) live here too. New write methods belong on a separate interface (e.g. `LiveTradingAdapter`) that scan / watch / paper never import.
4. **Events** — emit `EngineEvent` objects; don’t `console.log` ad-hoc from adapters.

## Adding a rule

1. Copy a block in `rules/example.yaml`.
2. Set `action: alert` (or `paper`). Avoid `live` until a real gated path exists.
3. Encode risk explicitly: `position_size_fraction`, `fire_after_n_losses`, caps.
4. For paper rules add an `exit` block; exit prices are for the held side (NO price for `side: no`).
5. Run `npm run scan -- --demo` then `npm run scan`.

## Adding / fixing an adapter

1. Implement `PlatformAdapter` in `src/platforms/<name>.ts`.
2. Register in `createAdapters` (`src/platforms/index.ts`).
3. Extend `PlatformId` union in `src/types.ts` and Zod `platforms` enum.
4. Add a few rows to `fixtures/markets.json` for `--demo`.
5. Never require auth for list/read used by scan.

## Risk engine

`src/engine/risk.ts` owns consecutive-loss pause, sizing and the bankroll/exposure gate. If you change pause semantics, update the example rule comments and README table.

## Platforms

- `polymarket_us` and `polymarket` are different exchanges (different markets, ids, fees). Never map one
  to the other; ledger positions keep the platform they were opened on, and paper runs create an adapter
  for every platform that still has open positions.
- Display names come from `platformName()` / `PLATFORM_NAMES` in `src/types.ts`.
- Missing platform data stays missing: a filter that needs it fails, except `volume24hUnavailable`
  (Polymarket US publishes no 24h volume), where the 24h-volume check is skipped and says so.

## Arbitrage

- `src/engine/match.ts` (pure title matching), `src/engine/arb.ts` (baskets + quotes, pure), and
  `src/engine/arb-runtime.ts` (discovery, alerts, paper open / unwind / finalize).
- A basket is legs (market + side) plus a guaranteed payout per set. New arbitrage kinds should be new
  basket builders in `discoverBaskets`, not new paths in the paper session.
- Arbitrage legs carry `groupId` and ruleId `arbitrage` (reserved). They are never exited by per-market
  rule logic. Groups are scored once when every leg has closed (`ledger.arbGroups`).
- Matching must stay conservative: a false match is two bets that can both lose. Add tests to
  `match.test.ts` for any loosening, including look-alikes that must NOT match.
- Same-site baskets rely only on platform flags (`mutually_exclusive`, neg-risk, "Other"), never on
  guessing from titles.

## Price history and unusual moves

- `src/engine/series.ts` stores our own snapshots (YES mid + 24h volume) per market; it's a cache next to
  the ledger (`*.history.json`), written under the ledger lock, safe to delete.
- `src/engine/unusual.ts` is pure. "Normal" is the RMS of window-length changes in the baseline,
  not tick variance scaled up (bid/ask flicker would look like volatility).
- Unusual-move signals are public-data heuristics. Keep the wording honest in UI and docs: the bot
  never claims to know who is trading.

## Fast mode and API keys

- `src/live-data/` streams prices only (Kalshi `ticker`, Polymarket US `MARKET_DATA_LITE`). Keys from `.env`
  sign the handshake; never log them, never add order/account calls there. Order code still belongs in a
  separate, gated module that paper / scan / watch never import.
- `LiveQuoteAdapter` wraps an adapter: REST data cached until the next full check, bid/ask replaced by a
  streamed quote. Streams drop their quotes whenever they disconnect, so a quote in the book is current.
  Markets carrying `quotedAt` are the only ones quick checks may trade. Status, resolution, liquidity and
  volume always come from REST.
- Fast ticks (`fastTick`) run exits + paper entries only; they don't write `lastPrices` or price history,
  and don't run arbitrage discovery or alert-only rules.

- Exact twins (`src/engine/exact-pairs.ts`) come from the platforms' ids, not titles: games need league,
  date and both teams to agree by abbreviation AND name (never trust one signal for which side is YES);
  election races need office, state, district, year and party, plus the same party/state/office words on
  both sides. Games trade (`matchedBy: "exact"`); races alert until confirmed (`"election"`), because the
  payout wording differs. Leave out leagues where a draw or tie can settle differently.

## Copy trading

- `src/platforms/polymarket-data.ts` (global Polymarket Data API, public), `src/engine/copy.ts` (pure:
  leaders, polling, matching, checks) and `src/engine/copy-runtime.ts` (paper session glue). Rule id
  `copy-leaders` is reserved; positions carry `copiedFrom` and exit with `leader_sold` when the leader sells.
- Matching is as conservative as arbitrage: exact game (teams + start time, side by team name) or the
  strict title matcher, plus a price-agreement check. Never guess a twin from loose titles.
- Kalshi leaders come from `src/platforms/kalshi-social.ts` (public social API: leaderboard, profile
  metrics, public trades; requests are spaced out because they share Kalshi's rate limit with the paper
  cycle). Their wallet key is `kalshi:<nickname>`; only taker fills are copied, on the same ticker. A
  trade's `price_dollars` is the YES price whichever side was taken. Kalshi parlays (`KXMVE…` tickers,
  legs in `mve_selected_legs`) are never copied as single bets.
- Parlays (`src/engine/parlays.ts`, rule id `copy-parlays`, `ledger.parlays`) are paper only. Legs come
  from bets copy trading already matched to a tradable market; one exchange and one leg per game per
  parlay; settled leg by leg (a lost leg loses it, a void leg drops out). Keep the price honest: legs'
  asks multiplied plus `combo_margin`, never better than the legs alone.

## Market timing and selection

- `NormalizedMarket.resolvesAt` (expected result) and `startsAt` (event start) are what timing filters use;
  `closesAt` is the platform's placeholder (Kalshi: latest expiry ≈ start + 48h; Polymarket US games:
  ~14 days after the start). Kalshi's start is inferred only from that fixed pattern (`kalshiTimes`).
- Kalshi's API lists the newest markets first (thousands of in-play props a day) and can't sort by volume,
  so `KalshiAdapter.listMarkets` takes upcoming games from the game-winner series first, then the busiest
  markets at least 2h old. Polymarket US game moneylines sit far down its volume order, so its listing
  scans a few pages for them. Keep the backtest (`history.ts`) on the same game-winner series.
- Stops: `evaluateExit(…, stopPrice)` compares the mid; the paper session confirms a loss exit on a second
  check ≥ 20s later (`exitPending` on the position) and never sells into a book wider than 10¢.

## Strategy league and backtests

- `src/league/`: `personas.ts` (names + traits, seeded), `genome.ts` (rookie rules per family, `mutate`,
  `describeRule`), `metrics.ts` (stats + steady score), `diagnose.ts` (plain-English findings),
  `league.ts` (league file `*.league.json` next to the ledger), `evolve.ts` (one round).
- League members are ordinary `Rule`s with ids `lg-…`, loaded by the paper session each cycle. They only
  trade when `gateCheck` passes (latest backtest profitable overall and held out, enough trades); bump
  `LEAGUE_RULE_STYLE` when guard rails change so old backtests are cleared and a round re-tests them. Retired
  members stay in the file (disabled) while they have open positions so their exits keep running.
- `src/backtest/`: `history.ts` (public price history, cached under `data/backtest/cache`), `replay.ts`
  (`ReplayAdapter`: read-only, never returns a price later than the replay time, settles at the close with
  the real result), `run.ts` (steps `runPaperCycle` over the window with a temp ledger).
- A backtest must go through the same paper engine. Don't add a second simulator; fix the engine or the
  replay adapter instead. Keep "no look-ahead" tests passing.
- Rounds run in a child process (`npm run league`) started by `paper:watch`, guarded by
  `data/backtest/round.lock`. Paper only, like everything else.

## Start / stop controls

- `src/engine/controls.ts`: `data/paper-ledger.controls.json`, written only by the dashboard's
  `POST /api/control` (JSON only, same-origin, localhost Host) and read by every paper cycle. Stopped
  bots get no entries; exits, settlement and copy sells always run. A Start is applied to the ledger once
  (`ruleState[id].resumedAt`) and lifts a loss pause. Keep any new strategy behind `isStopped`.

## Paper ledger

- `src/ledger/paper.ts` is the only writer of `data/paper-ledger*.json` (gitignored). Bump `version` and add a migration if you change its shape; v1 → v2 already exists.
- `src/engine/paper-session.ts` runs one cycle: exits first, then entries. Paper risk state is rebuilt from the ledger each cycle — don't keep a second copy.
- Exit and fill math stay platform-agnostic (`exits.ts`, `pricing.ts`). Platform fee models and contract rounding belong in adapters.
- Adapters must map an empty book side to `undefined`, never to a 0 bid / 1.00 ask, and only report `status: "resolved"` once the result is final (not disputed). Never sell a paper position into an empty book.
- Demo and real-data ledgers must never mix (enforced on load).

## Live trading (future)

If implementing live:

1. New module e.g. `src/platforms/live/` — **not** imported by scan/watch.
2. Require `ENABLE_LIVE_TRADING=true`, `ALLOW_LIVE=true`, and `--i-understand-live`.
3. Keep `npm run live` refusing until order code is reviewed.
4. Still run the same `checkEntryRisk` before any order.

## Quick checks before you finish a change

```bash
npm run typecheck
npm test
npm run scan -- --demo
npm run live    # should exit non-zero with a clear stub message
```
