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
3. **`PlatformAdapter.listMarkets`** — public reads only. New write methods belong on a separate interface (e.g. `LiveTradingAdapter`) that scan never imports.
4. **Events** — emit `EngineEvent` objects; don’t `console.log` ad-hoc from adapters.

## Adding a rule

1. Copy a block in `rules/example.yaml`.
2. Set `action: alert` (or `paper`). Avoid `live` until a real gated path exists.
3. Encode risk explicitly: `position_size_fraction`, `fire_after_n_losses`, caps.
4. Run `npm run scan -- --demo` then `npm run scan`.

## Adding / fixing an adapter

1. Implement `PlatformAdapter` in `src/platforms/<name>.ts`.
2. Register in `createAdapters` (`src/platforms/index.ts`).
3. Extend `PlatformId` union in `src/types.ts` and Zod `platforms` enum.
4. Add a few rows to `fixtures/markets.json` for `--demo`.
5. Never require auth for list/read used by scan.

## Risk engine

`src/engine/risk.ts` owns consecutive-loss pause and sizing. If you change pause semantics, update the example rule comments and README table. Paper fills live in `data/paper-ledger.json` (gitignored).

## Live trading (future)

If implementing live:

1. New module e.g. `src/platforms/live/` — **not** imported by scan/watch.
2. Require `ENABLE_LIVE_TRADING=true`, `ALLOW_LIVE=true`, and `--i-understand-live`.
3. Keep `npm run live` refusing until order code is reviewed.
4. Still run the same `checkEntryRisk` before any order.

## Quick checks before you finish a change

```bash
npm run typecheck
npm run scan -- --demo
npm run live    # should exit non-zero with a clear stub message
```
