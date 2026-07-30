import assert from "node:assert/strict";
import { Readable } from "node:stream";
import test from "node:test";
import { Headers, Response } from "node-fetch";
import KeyManager from "../../src/keyManager.js";
import {
  createGeminiInteractionsClient,
  parseSse,
} from "../../src/geminiInteractionsClient.js";

test("fragmented and multiline SSE frames parse correctly", async () => {
  const body = Readable.from([
    Buffer.from(": comment\r\ndata: {\"event_type\":\"step.delta\",\r\n"),
    Buffer.from("data: \"index\":0,\"delta\":{\"type\":\"text\",\"text\":\"hi\"}}\r\n\r"),
    Buffer.from("\ndata: [DONE]\n\n"),
  ]);
  const events = [];
  for await (const event of parseSse(body)) events.push(event);
  assert.equal(events[0].event_type, "step.delta");
  assert.equal(events[0].delta.text, "hi");
  assert.equal(events[1].event_type, "done");
});

test("Interactions rotates before a stream, then never replays a partial stream", async () => {
  const manager = new KeyManager(["first", "second", "third"], {
    cooldownMs: 1000,
    now: () => 0,
  });
  const attempts = [];
  const events = [];
  const fetchImpl = async (_url, options) => {
    const key = options.headers["x-goog-api-key"];
    attempts.push(key);
    if (key === "first") {
      return new Response(JSON.stringify({ error: { message: "quota" } }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      });
    }
    async function* brokenStream() {
      yield Buffer.from(
        'data: {"event_type":"interaction.created","interaction":{"status":"in_progress"}}\n\n'
      );
      yield Buffer.from(
        'data: {"event_type":"step.start","index":0,"step":{"type":"model_output"}}\n\n'
      );
      yield Buffer.from(
        'data: {"event_type":"step.delta","index":0,"delta":{"type":"text","text":"partial"}}\n\n'
      );
      throw new Error("socket broke");
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: brokenStream(),
    };
  };
  const client = createGeminiInteractionsClient({
    keyManager: manager,
    fetchImpl,
    baseUrl: "https://mock.invalid",
  });
  const result = await client.create({
    request: { model: "gemini-3.6-flash", input: "hello", store: false },
    stream: true,
    onEvent: (event) => events.push(event),
  });
  assert.equal(result.ok, false);
  assert.equal(result.streamStarted, true);
  assert.deepEqual(attempts, ["first", "second"]);
  assert.equal(events.at(-1).delta.text, "partial");
  assert.ok(manager.keys[0].blockedUntil > 0);
  assert.ok(manager.keys[1].blockedUntil > 0);
  assert.equal(manager.keys[2].blockedUntil, 0);
});

test("client cancellation aborts a started upstream stream without key replay", async () => {
  const manager = new KeyManager(["first", "second"], { now: Date.now });
  const controller = new AbortController();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    async function* stream() {
      yield Buffer.from(
        'data: {"event_type":"interaction.created","interaction":{"status":"in_progress"}}\n\n'
      );
      if (controller.signal.aborted) throw new Error("cancelled");
      await new Promise((resolve) => controller.signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("cancelled");
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ "Content-Type": "text/event-stream" }),
      body: stream(),
    };
  };
  const client = createGeminiInteractionsClient({
    keyManager: manager,
    fetchImpl,
    baseUrl: "https://mock.invalid",
  });
  const pending = client.create({
    request: { model: "gemini-3.6-flash", input: "hello" },
    stream: true,
    signal: controller.signal,
    onEvent: () => controller.abort(),
  });
  const result = await pending;
  assert.equal(result.aborted, true);
  assert.equal(result.streamStarted, true);
  assert.equal(attempts, 1);
  assert.equal(manager.keys[1].blockedUntil, 0);
});
