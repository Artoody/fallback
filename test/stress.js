import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { Readable } from "node:stream";
import KeyManager from "../src/keyManager.js";
import { runKeyPool } from "../src/keyPoolPolicy.js";
import { buildToolRegistry } from "../src/codex/requestAdapter.js";
import { ResponsesStreamAdapter } from "../src/codex/responseAdapter.js";
import { createStateEnvelope } from "../src/codex/stateEnvelope.js";
import { parseSse } from "../src/geminiInteractionsClient.js";

const KEY_COUNT = 17;
const CONCURRENCY = 50;

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] || 0;
}

async function concurrentMap(count, concurrency, worker) {
  let next = 0;
  const results = Array(count);
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const index = next++;
        if (index >= count) return;
        results[index] = await worker(index);
      }
    })
  );
  return results;
}

async function healthyScenario() {
  const manager = new KeyManager(
    Array.from({ length: KEY_COUNT }, (_, index) => `stress-key-${index}`),
    { now: Date.now }
  );
  const starts = Array(KEY_COUNT).fill(0);
  const overhead = [];
  await concurrentMap(1700, CONCURRENCY, async () => {
    const started = performance.now();
    const result = await runKeyPool({
      keyManager: manager,
      attempt: async (key) => {
        starts[key.index] += 1;
        return { decision: "success", status: 200 };
      },
    });
    assert.equal(result.ok, true);
    overhead.push(performance.now() - started);
  });
  assert.deepEqual(starts, Array(KEY_COUNT).fill(100));
  return { starts, p95OverheadMs: percentile(overhead, 0.95) };
}

async function exerciseFragmentedAdapter(job, stateEnvelope) {
  const events = [];
  const registry =
    job % 3 === 0
      ? buildToolRegistry([{ type: "custom", name: "apply_patch" }])
      : buildToolRegistry([]);
  const adapter = new ResponsesStreamAdapter({
    model: "gemini-3.6-flash",
    registry,
    stateEnvelope,
    clientId: `stress-client-${job % 7}`,
    emit: (event) => events.push(event),
  });
  const finalStep =
    job % 3 === 0
      ? {
          type: "function_call",
          name: "apply_patch",
          arguments: { input: "*** Begin Patch\n*** End Patch" },
          id: `call_${job}`,
        }
      : { type: "model_output", content: [{ type: "text", text: `ok-${job}` }] };
  const frames = [
    { event_type: "interaction.created", interaction: { status: "in_progress" } },
    { event_type: "step.start", index: 0, step: { type: finalStep.type, name: finalStep.name, id: finalStep.id } },
    ...(finalStep.type === "function_call"
      ? [
          {
            event_type: "step.delta",
            index: 0,
            delta: { type: "arguments_delta", arguments: JSON.stringify(finalStep.arguments) },
          },
        ]
      : [
          {
            event_type: "step.delta",
            index: 0,
            delta: { type: "text", text: `ok-${job}` },
          },
        ]),
    { event_type: "step.stop", index: 0 },
    {
      event_type: "interaction.completed",
      interaction: {
        status: "completed",
        steps: [finalStep],
        usage: { total_input_tokens: 2, total_output_tokens: 1 },
      },
    },
  ];
  const wire = frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("");
  const cuts = [wire.slice(0, 11), wire.slice(11, 53), wire.slice(53, 131), wire.slice(131)];
  for await (const event of parseSse(Readable.from(cuts))) adapter.handle(event);
  assert.equal(events.at(-1).type, "response.completed");
  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index)
  );
  return events.length;
}

async function mixedScenario() {
  let logicalNow = 0;
  const manager = new KeyManager(
    Array.from({ length: KEY_COUNT }, (_, index) => `mixed-key-${index}`),
    { cooldownMs: 10, invalidKeyCooldownMs: 100, now: () => logicalNow }
  );
  const stateEnvelope = createStateEnvelope({ secret: "66".repeat(32) });
  const cooldownViolations = [];
  const perRequestAttempts = [];
  let terminalResponses = 0;
  let structuredErrors = 0;
  let eventCount = 0;

  await concurrentMap(1000, CONCURRENCY, async (job) => {
    const seen = new Set();
    let attemptNumber = 0;
    const result = await runKeyPool({
      keyManager: manager,
      attempt: async (key) => {
        if (key.blockedUntil > logicalNow) cooldownViolations.push([job, key.index]);
        logicalNow += 20;
        assert.equal(seen.has(key.index), false);
        seen.add(key.index);
        attemptNumber += 1;
        if ((job % 19 === 0 || job % 23 === 0) && attemptNumber === 1) {
          await new Promise((resolve) => setTimeout(resolve, job % 3));
          return { decision: "retry", status: job % 19 === 0 ? 429 : 503 };
        }
        if (job % 53 === 0 && attemptNumber === 1) {
          return { decision: "return", status: 502, streamStarted: true };
        }
        return { decision: "success", status: 200 };
      },
    });
    perRequestAttempts.push(seen.size);
    assert.ok(seen.size <= KEY_COUNT);
    if (result.ok) {
      eventCount += await exerciseFragmentedAdapter(job, stateEnvelope);
      terminalResponses += 1;
    } else {
      assert.ok(result.status >= 400);
      structuredErrors += 1;
    }
  });

  assert.equal(cooldownViolations.length, 0);
  assert.equal(terminalResponses + structuredErrors, 1000);
  assert.ok(perRequestAttempts.every((count) => count <= KEY_COUNT));
  return { terminalResponses, structuredErrors, eventCount };
}

const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
const rssBefore = process.memoryUsage().rss;
const healthy = await healthyScenario();
const mixed = await mixedScenario();
await new Promise((resolve) => setImmediate(resolve));
lag.disable();
const rssGrowthMiB = (process.memoryUsage().rss - rssBefore) / 1024 / 1024;
const eventLoopLagP95Ms = lag.percentile(95) / 1e6;

assert.ok(healthy.p95OverheadMs < 100, `p95 overhead was ${healthy.p95OverheadMs.toFixed(2)} ms`);
assert.ok(eventLoopLagP95Ms < 100, `event-loop p95 was ${eventLoopLagP95Ms.toFixed(2)} ms`);
assert.ok(rssGrowthMiB < 100, `RSS grew ${rssGrowthMiB.toFixed(2)} MiB`);

const report = {
  healthy: {
    requests: 1700,
    concurrency: CONCURRENCY,
    startingKeyCounts: healthy.starts,
    p95GatewayOverheadMs: Number(healthy.p95OverheadMs.toFixed(3)),
  },
  mixed: {
    requests: 1000,
    concurrency: CONCURRENCY,
    ...mixed,
    cooldownViolations: 0,
  },
  eventLoopLagP95Ms: Number(eventLoopLagP95Ms.toFixed(3)),
  rssGrowthMiB: Number(rssGrowthMiB.toFixed(3)),
  leakedCredentialsOrStateEnvelopes: 0,
};

assert.equal(JSON.stringify(report).includes("gemini-state."), false);
assert.equal(JSON.stringify(report).includes("stress-key-"), false);
console.log(JSON.stringify(report, null, 2));
