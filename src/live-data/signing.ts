import { constants, sign, type KeyObject } from "node:crypto";

/** Path Kalshi signs for the WebSocket handshake. */
export const KALSHI_WS_PATH = "/trade-api/ws/v2";
/** Polymarket US market-data socket. */
export const POLYMARKET_US_WS_PATH = "/v1/ws/markets";

/**
 * Kalshi: sign `${timestampMs}GET/trade-api/ws/v2` with RSA-PSS (SHA-256, salt = digest length),
 * or plain Ed25519 for Ed25519 keys; base64 in KALSHI-ACCESS-SIGNATURE.
 */
export function kalshiWsHeaders(keyId: string, key: KeyObject, nowMs = Date.now()): Record<string, string> {
  const ts = String(nowMs);
  const msg = Buffer.from(`${ts}GET${KALSHI_WS_PATH}`, "utf8");
  const sig =
    key.asymmetricKeyType === "ed25519"
      ? sign(null, msg, key)
      : sign("sha256", msg, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST });
  return {
    "KALSHI-ACCESS-KEY": keyId,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    "KALSHI-ACCESS-SIGNATURE": sig.toString("base64"),
  };
}

/** Polymarket US: Ed25519 over `${timestampMs}${method}${path}`, base64 in X-PM-Signature. */
export function polymarketUsHeaders(keyId: string, key: KeyObject, method: string, path: string, nowMs = Date.now()): Record<string, string> {
  const ts = String(nowMs);
  const sig = sign(null, Buffer.from(`${ts}${method}${path}`, "utf8"), key);
  return {
    "X-PM-Access-Key": keyId,
    "X-PM-Timestamp": ts,
    "X-PM-Signature": sig.toString("base64"),
  };
}
