import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { Response } from "node-fetch";
import createApp from "../../src/app.js";

const CLIENT_KEY = "test-client-key";
const STATE_SECRET = "55".repeat(32);

async function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-app-"));
  const interactions = [];
  const logs = [];
  const logger = {
    log: (...args) => logs.push(args.join(" ")),
    warn: (...args) => logs.push(args.join(" ")),
    error: (...args) => logs.push(args.join(" ")),
  };

  const fetchImpl = async (rawUrl, options = {}) => {
    const url = new URL(String(rawUrl));
    if (url.pathname.endsWith("/interactions")) {
      const body = JSON.parse(options.body);
      interactions.push(body);
      if (body.stream) {
        const frames = [
          '{"event_type":"interaction.created","interaction":{"status":"in_progress"}}',
          '{"event_type":"step.start","index":0,"step":{"type":"model_output"}}',
          '{"event_type":"step.delta","index":0,"delta":{"type":"text","text":"stre"}}',
          '{"event_type":"step.delta","index":0,"delta":{"type":"text","text":"amed"}}',
          '{"event_type":"step.stop","index":0}',
          '{"event_type":"interaction.completed","interaction":{"status":"completed","steps":[{"type":"model_output","content":[{"type":"text","text":"streamed"}]}],"usage":{"total_input_tokens":2,"total_output_tokens":1}}}',
        ];
        const wire = frames.map((frame) => `data: ${frame}\n\n`).join("") + "data: [DONE]\n\n";
        const fragments = [wire.slice(0, 37), wire.slice(37, 121), wire.slice(121)];
        return new Response(Readable.from(fragments), {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        });
      }

      const hasResult = body.input.some((step) => step.type === "function_result");
      if (hasResult) {
        return new Response(
          JSON.stringify({
            status: "completed",
            steps: [{ type: "model_output", content: [{ type: "text", text: "tool loop done" }] }],
            usage: { total_input_tokens: 8, total_output_tokens: 3 },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      if (body.tools?.some((tool) => tool.name === "inspect_repo")) {
        return new Response(
          JSON.stringify({
            status: "requires_action",
            steps: [
              {
                type: "thought",
                signature: "opaque-thought-signature",
                summary: [{ type: "text", text: "Inspect first." }],
              },
              {
                type: "function_call",
                name: "inspect_repo",
                arguments: { path: "." },
                id: "call_inspect",
              },
            ],
            usage: {
              total_input_tokens: 4,
              total_output_tokens: 2,
              total_thought_tokens: 1,
              total_tool_use_tokens: 1,
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } }
        );
      }
      return new Response(
        JSON.stringify({
          status: "completed",
          steps: [
            {
              type: "model_output",
              content: [
                {
                  type: "text",
                  text: "hello",
                  annotations: [
                    {
                      type: "url_citation",
                      start_index: 0,
                      end_index: 5,
                      title: "Example",
                      url: "https://example.com",
                    },
                  ],
                },
              ],
            },
          ],
          usage: { total_input_tokens: 2, total_output_tokens: 1, total_cached_tokens: 1 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname.endsWith("/openai/chat/completions")) {
      return new Response(
        JSON.stringify({
          id: "chat_1",
          choices: [{ message: { role: "assistant", content: "chat works" } }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname.includes("/v1beta/models/")) {
      return new Response(
        JSON.stringify({
          candidates: [{ content: { parts: [{ text: "native works" }] } }],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }
    if (url.pathname.endsWith("/v1beta/models")) {
      return new Response(JSON.stringify({ models: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    throw new Error(`Unexpected mock URL ${url.pathname}`);
  };

  const runtime = createApp({
    env: {
      DATA_DIR: dataDir,
      GEMINI_API_KEYS: "fake-gemini-a,fake-gemini-b",
      PROXY_API_KEY: CLIENT_KEY,
      ADMIN_PASSWORD: "test-admin-password",
      RESPONSES_STATE_SECRET: STATE_SECRET,
      GOOGLE_BASE_URL: "https://mock.invalid",
    },
    fetchImpl,
    logger,
  });
  const server = await new Promise((resolve) => {
    const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    runtime.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { baseUrl, interactions, logs };
}

function auth(extra = {}) {
  return { Authorization: `Bearer ${CLIENT_KEY}`, "Content-Type": "application/json", ...extra };
}

test("authenticated Codex catalog and non-streaming Responses work", async (t) => {
  const { baseUrl } = await setup(t);
  const unauthorized = await fetch(`${baseUrl}/v1/models`);
  assert.equal(unauthorized.status, 401);

  const catalog = await fetch(`${baseUrl}/v1/models?client_version=0.146.0`, {
    headers: auth(),
  });
  assert.equal(catalog.status, 200);
  const catalogBody = await catalog.json();
  assert.deepEqual(
    catalogBody.models.map((model) => model.slug),
    ["gemini-3.6-flash", "gemini-3.1-pro-preview-customtools"]
  );

  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: "gemini-3.6-flash",
      input: "hello",
      store: false,
      stream: false,
    }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.output.find((item) => item.type === "message").content[0].text, "hello");
  assert.ok(body.output.some((item) => item.encrypted_content));
});

test("a complete reasoning-backed inspect/tool-result loop replays exact Gemini state", async (t) => {
  const { baseUrl, interactions } = await setup(t);
  const firstResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: "gemini-3.6-flash",
      input: "inspect this repository",
      store: false,
      tools: [
        {
          type: "function",
          name: "inspect_repo",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    }),
  });
  const first = await firstResponse.json();
  const call = first.output.find((item) => item.type === "function_call");
  assert.equal(call.call_id, "call_inspect");

  const secondResponse = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: "gemini-3.6-flash",
      input: [
        ...first.output,
        { type: "function_call_output", call_id: call.call_id, output: "repository contents" },
      ],
      store: false,
      tools: [
        {
          type: "function",
          name: "inspect_repo",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      ],
    }),
  });
  assert.equal(secondResponse.status, 200);
  const second = await secondResponse.json();
  assert.equal(
    second.output.find((item) => item.type === "message").content[0].text,
    "tool loop done"
  );
  const replay = interactions.at(-1).input;
  assert.equal(replay[0].type, "thought");
  assert.equal(replay[0].signature, "opaque-thought-signature");
  assert.equal(replay[1].type, "function_call");
  assert.equal(replay[2].type, "function_result");
  assert.equal(replay[2].call_id, "call_inspect");
});

test("streaming Responses emit deltas, a terminal event, and [DONE]", async (t) => {
  const { baseUrl } = await setup(t);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({
      model: "gemini-3.6-flash",
      input: "stream",
      store: false,
      stream: true,
    }),
  });
  assert.equal(response.status, 200);
  const wire = await response.text();
  assert.match(wire, /"type":"response\.output_text\.delta"/);
  assert.match(wire, /"type":"response\.completed"/);
  assert.match(wire, /data: \[DONE\]/);
});

test("Chat Completions, Gemini-native, health, and admin APIs remain available", async (t) => {
  const { baseUrl } = await setup(t);
  const health = await fetch(`${baseUrl}/`);
  assert.equal(health.status, 200);

  const chat = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "gemini-3.6-flash", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(chat.status, 200);
  assert.equal((await chat.json()).choices[0].message.content, "chat works");

  const native = await fetch(`${baseUrl}/v1beta/models/gemini-3.6-flash:generateContent`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ contents: [{ parts: [{ text: "hi" }] }] }),
  });
  assert.equal(native.status, 200);
  assert.equal((await native.json()).candidates[0].content.parts[0].text, "native works");

  const clients = await fetch(`${baseUrl}/admin/api/clients`, {
    headers: { "x-admin-password": "test-admin-password" },
  });
  assert.equal(clients.status, 200);
  assert.equal((await clients.json()).clients[0].source, "env-proxy");
});

test("tampered or wrong-client state is rejected and never reaches Gemini", async (t) => {
  const { baseUrl, interactions } = await setup(t);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "gemini-3.6-flash", input: "hello", store: false }),
  });
  const first = await response.json();
  const state = first.output.find((item) => item.encrypted_content);
  state.encrypted_content = `${state.encrypted_content.slice(0, -1)}x`;
  const before = interactions.length;
  const tampered = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "gemini-3.6-flash", input: [state], store: false }),
  });
  assert.equal(tampered.status, 400);
  assert.equal((await tampered.json()).error.code, "invalid_state_envelope");
  assert.equal(interactions.length, before);
});

test("credentials and state envelopes never enter application logs", async (t) => {
  const { baseUrl, logs } = await setup(t);
  const response = await fetch(`${baseUrl}/v1/responses`, {
    method: "POST",
    headers: auth(),
    body: JSON.stringify({ model: "gemini-3.6-flash", input: "hello", store: false }),
  });
  const body = await response.json();
  const envelope = body.output.find((item) => item.encrypted_content).encrypted_content;
  const joined = logs.join("\n");
  assert.equal(joined.includes(CLIENT_KEY), false);
  assert.equal(joined.includes(STATE_SECRET), false);
  assert.equal(joined.includes(envelope), false);
});

test("an environment-client rotation makes the exact old credential return 401", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-auth-rotation-"));
  const common = {
    DATA_DIR: dataDir,
    GEMINI_API_KEYS: "fake-gemini",
    ADMIN_PASSWORD: "admin",
    RESPONSES_STATE_SECRET: STATE_SECRET,
  };
  const quiet = { log() {}, warn() {}, error() {} };
  const first = createApp({
    env: { ...common, PROXY_API_KEY: "old-exposed-client" },
    fetchImpl: async () => assert.fail("no Gemini request expected"),
    logger: quiet,
  });
  first.close();
  const second = createApp({
    env: { ...common, PROXY_API_KEY: "new-rotated-client" },
    fetchImpl: async () => assert.fail("no Gemini request expected"),
    logger: quiet,
  });
  const server = await new Promise((resolve) => {
    const listening = second.app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    second.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const oldResponse = await fetch(`${baseUrl}/debug/keys-status`, {
    headers: { Authorization: "Bearer old-exposed-client" },
  });
  const newResponse = await fetch(`${baseUrl}/debug/keys-status`, {
    headers: { Authorization: "Bearer new-rotated-client" },
  });
  assert.equal(oldResponse.status, 401);
  assert.equal(newResponse.status, 200);
});
