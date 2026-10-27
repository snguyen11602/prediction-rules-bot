#!/usr/bin/env node
/**
 * Live trading is intentionally NOT implemented.
 * This command only explains the gates and exits non-zero.
 *
 * Future work must:
 * 1) Require ENABLE_LIVE_TRADING=true AND ALLOW_LIVE=true AND --i-understand-live
 * 2) Use platform-private APIs with keys from env (never committed)
 * 3) Still honor the shared risk schema (consecutive-loss pause, size fraction, caps)
 * 4) Never place orders from alert/paper/scan/watch entrypoints
 */

function gatesOk(): boolean {
  return (
    process.env.ENABLE_LIVE_TRADING === "true" &&
    process.env.ALLOW_LIVE === "true" &&
    process.argv.includes("--i-understand-live")
  );
}

// eslint-disable-next-line no-console
console.error(`
LIVE TRADING: not implemented / needs keys

This starter refuses to place real orders.

To even consider a future live path you would need ALL of:
  ENABLE_LIVE_TRADING=true
  ALLOW_LIVE=true
  CLI flag --i-understand-live
  Kalshi: API key + private key for signed trading endpoints
  Polymarket: wallet private key (L1) + CLOB API credentials (L2)

Current gate status: ${gatesOk() ? "ENV FLAGS SET — but order placement is still stubbed" : "BLOCKED (flags missing)"}

Use instead:
  npm run scan   # alerts from public market data
  npm run watch  # poll + alerts
  npm run paper  # hypothetical fills in data/paper-ledger.json
`);

process.exit(1);
