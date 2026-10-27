/**
 * Public GET with polite retries. Kalshi and Polymarket rate-limit (HTTP 429);
 * back off (honouring Retry-After) instead of failing the whole scan.
 */
const HEADERS = {
  Accept: "application/json",
  "User-Agent": "prediction-rules-bot/0.1 (public-read)",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function getJson<T>(url: string | URL, label: string, opts: { retries?: number; timeoutMs?: number } = {}): Promise<{ status: number; data?: T }> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    if (res.status === 404) return { status: 404 };
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get("retry-after"));
      await res.body?.cancel().catch(() => undefined);
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 30) * 1000 : 1000 * 2 ** attempt);
      continue;
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`${label} HTTP ${res.status} ${res.statusText}${res.status === 429 ? " (rate limited — try a longer --interval)" : ""}: ${body.slice(0, 200)}`);
    }
    return { status: res.status, data: (await res.json()) as T };
  }
}
