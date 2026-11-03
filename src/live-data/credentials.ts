import { readFileSync } from "node:fs";
import { createPrivateKey, type KeyObject } from "node:crypto";
import path from "node:path";
import os from "node:os";

/**
 * API keys for READ-ONLY streaming market data. They're read from the local `.env`
 * (or the environment) and only used to sign the WebSocket handshake. Nothing in
 * src/live-data places, changes or cancels orders, and key material is never logged.
 */

export interface KalshiCreds {
  keyId: string;
  key: KeyObject;
}

export interface PolymarketUsCreds {
  keyId: string;
  /** Ed25519 signing key built from the base64 secret. */
  key: KeyObject;
}

export interface StreamCreds {
  kalshi?: KalshiCreds;
  polymarketUs?: PolymarketUsCreds;
  /** Human-readable problems (never containing key material). */
  problems: string[];
}

/** Minimal .env reader: KEY=value lines, # comments, optional quotes. Existing env wins. */
export function loadDotEnv(file = path.resolve(".env"), env: NodeJS.ProcessEnv = process.env): boolean {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return false;
  }
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (env[m[1]] == null || env[m[1]] === "") env[m[1]] = v;
  }
  return true;
}

function expandHome(p: string): string {
  return p.startsWith("~/") ? path.join(os.homedir(), p.slice(2)) : p;
}

/** PKCS#8 DER prefix for a raw 32-byte Ed25519 seed. */
const ED25519_PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

export function ed25519FromBase64Seed(secret: string): KeyObject {
  const bytes = Buffer.from(secret.trim(), "base64");
  // Polymarket US secrets are a 32-byte seed, or 64 bytes (seed + public key).
  if (bytes.length !== 32 && bytes.length !== 64) throw new Error(`expected a 32- or 64-byte base64 key, got ${bytes.length} bytes`);
  return createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, bytes.subarray(0, 32)]), format: "der", type: "pkcs8" });
}

export function readStreamCreds(env: NodeJS.ProcessEnv = process.env): StreamCreds {
  const problems: string[] = [];
  const out: StreamCreds = { problems };

  const kId = env.KALSHI_API_KEY_ID?.trim();
  const kPath = env.KALSHI_PRIVATE_KEY_PATH?.trim();
  if (kId && kPath) {
    if (/BEGIN|PRIVATE KEY|^MI[IG]/.test(kPath) || kPath.length > 1024) {
      // Someone pasted the key itself; never echo it back.
      problems.push("KALSHI_PRIVATE_KEY_PATH must be the path to your key file, not the key itself");
    } else {
      let pem: string | undefined;
      try {
        pem = readFileSync(expandHome(kPath), "utf8");
      } catch (err) {
        // Error code only: messages include the path, which could be anything the user typed.
        const code = (err as NodeJS.ErrnoException).code ?? "unreadable";
        problems.push(`Kalshi key file at KALSHI_PRIVATE_KEY_PATH couldn't be opened (${code === "ENOENT" ? "no file there" : code})`);
      }
      if (pem != null) {
        try {
          const key = createPrivateKey(pem);
          const type = key.asymmetricKeyType;
          if (type !== "rsa" && type !== "ed25519") throw new Error("unsupported");
          out.kalshi = { keyId: kId, key };
        } catch {
          problems.push("The file at KALSHI_PRIVATE_KEY_PATH isn't a Kalshi private key (expected the .key / .pem file Kalshi gave you)");
        }
      }
    }
  } else if (kId || kPath) {
    problems.push("Kalshi needs both KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH in .env");
  }

  const pId = env.POLYMARKET_KEY_ID?.trim();
  const pSecret = env.POLYMARKET_SECRET_KEY?.trim();
  if (pId && pSecret) {
    try {
      out.polymarketUs = { keyId: pId, key: ed25519FromBase64Seed(pSecret) };
    } catch {
      problems.push("POLYMARKET_SECRET_KEY isn't a valid Polymarket US secret key (expected the Secret Key shown once at polymarket.us/developer)");
    }
  } else if (pId || pSecret) {
    problems.push("Polymarket US needs both POLYMARKET_KEY_ID and POLYMARKET_SECRET_KEY in .env");
  }
  return out;
}
