import { test } from "node:test";
import assert from "node:assert/strict";
import { getJson } from "./http.js";

function withFetch<T>(impl: typeof fetch, fn: () => Promise<T>): Promise<T> {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return fn().finally(() => {
    globalThis.fetch = real;
  });
}
const timeout = () => Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" });

test("a timed-out request is tried once more before it counts as a failure", async () => {
  let calls = 0;
  const flaky = (async () => {
    if (++calls === 1) throw timeout();
    return new Response(JSON.stringify({ ok: 1 }), { status: 200 });
  }) as typeof fetch;
  const res = await withFetch(flaky, () => getJson<{ ok: number }>("https://example.test/x", "Kalshi"));
  assert.equal(res.data?.ok, 1);
  assert.equal(calls, 2);
});

test("two timeouts in a row fail with a plain message", async () => {
  let calls = 0;
  const dead = (async () => {
    calls++;
    throw timeout();
  }) as typeof fetch;
  await assert.rejects(withFetch(dead, () => getJson("https://example.test/x", "Polymarket US")), /Polymarket US didn't answer in time \(tried 2 times\)/);
  assert.equal(calls, 2);
  const down = (async () => {
    throw new TypeError("fetch failed");
  }) as typeof fetch;
  await assert.rejects(withFetch(down, () => getJson("https://example.test/x", "Kalshi")), /Kalshi couldn't be reached/);
});
