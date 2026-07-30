import assert from "node:assert/strict";
import test from "node:test";
import KeyManager from "../../src/keyManager.js";
import { runKeyPool } from "../../src/keyPoolPolicy.js";

test("round-robin starting keys are exactly even", () => {
  const manager = new KeyManager(
    Array.from({ length: 17 }, (_, index) => `key-${index}`),
    { now: () => 0 }
  );
  const starts = Array(17).fill(0);
  for (let index = 0; index < 1700; index += 1) starts[manager.getAvailableOrder()[0].index] += 1;
  assert.deepEqual(starts, Array(17).fill(100));
});

test("retryable and invalid failures rotate once per ready key", async () => {
  let now = 1000;
  const manager = new KeyManager(["a", "b", "c"], {
    cooldownMs: 100,
    invalidKeyCooldownMs: 1000,
    now: () => now,
  });
  const attempts = [];
  const result = await runKeyPool({
    keyManager: manager,
    attempt: async (key) => {
      attempts.push(key.key);
      if (key.key === "a") return { decision: "retry", status: 429 };
      if (key.key === "b") return { decision: "invalid", status: 400 };
      return { decision: "success", status: 200, data: "ok" };
    },
  });
  assert.equal(result.ok, true);
  assert.deepEqual(attempts, ["a", "b", "c"]);
  assert.equal(manager.keys[0].blockedUntil, 1100);
  assert.equal(manager.keys[1].blockedUntil, 2000);
  assert.equal(manager.keys[2].blockedUntil, 0);

  now = 1050;
  assert.deepEqual(manager.getAvailableOrder().map((key) => key.key), ["c"]);
});

test("non-retryable client errors return immediately", async () => {
  const manager = new KeyManager(["a", "b"], { now: () => 0 });
  let attempts = 0;
  const result = await runKeyPool({
    keyManager: manager,
    attempt: async () => {
      attempts += 1;
      return { decision: "return", status: 400, error: "bad request" };
    },
  });
  assert.equal(result.status, 400);
  assert.equal(attempts, 1);
  assert.equal(manager.keys[0].blockedUntil, 0);
});

test("all-cooldown responses include the earliest retry time", async () => {
  let now = 10;
  const manager = new KeyManager(["a", "b"], { cooldownMs: 500, now: () => now });
  manager.markRateLimited(manager.keys[0], 300);
  manager.markRateLimited(manager.keys[1], 700);
  const result = await runKeyPool({
    keyManager: manager,
    attempt: async () => assert.fail("no blocked key should be attempted"),
  });
  assert.equal(result.status, 429);
  assert.equal(result.retryAfterMs, 300);
});

test("a midstream failure is returned without replay", async () => {
  const manager = new KeyManager(["a", "b"], { now: () => 0 });
  let attempts = 0;
  const result = await runKeyPool({
    keyManager: manager,
    attempt: async () => {
      attempts += 1;
      return { decision: "return", status: 502, streamStarted: true };
    },
  });
  assert.equal(result.ok, false);
  assert.equal(attempts, 1);
  assert.ok(manager.keys[0].blockedUntil > 0);
});
