# AGENTS.md — extending prediction-rules-bot

Guidance for Claude, Cursor, Grok Bot, or any assistant continuing this repo.

## Goals

- Keep **one shared rule schema** for Kalshi and Polymarket.
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
