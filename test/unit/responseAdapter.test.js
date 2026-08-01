import assert from "node:assert/strict";
import test from "node:test";
import { buildToolRegistry } from "../../src/codex/requestAdapter.js";
import {
  ResponsesStreamAdapter,
  translateGeminiInteraction,
} from "../../src/codex/responseAdapter.js";
import { createStateEnvelope } from "../../src/codex/stateEnvelope.js";

const stateEnvelope = createStateEnvelope({ secret: "44".repeat(32) });

test("non-streaming output preserves reasoning, citations, namespace identity, and usage", () => {
  const registry = buildToolRegistry([
    {
      type: "namespace",
      name: "files",
      tools: [{ name: "read", parameters: { type: "object" } }],
    },
  ]);
  const geminiName = registry.geminiTools[0].name;
  const interaction = {
    status: "requires_action",
    steps: [
      {
        type: "thought",
        signature: "thought-signature",
        summary: [{ type: "text", text: "I should inspect the file." }],
      },
      {
        type: "model_output",
        content: [
          {
            type: "text",
            text: "Source",
            annotations: [
              {
                type: "url_citation",
                start_index: 0,
                end_index: 6,
                title: "Example",
                url: "https://example.com",
              },
            ],
          },
        ],
      },
      { type: "function_call", name: geminiName, arguments: { path: "a.js" }, id: "call_1" },
    ],
    usage: {
      total_input_tokens: 10,
      total_cached_tokens: 4,
      total_output_tokens: 5,
      total_thought_tokens: 2,
      total_tool_use_tokens: 3,
    },
  };
  const response = translateGeminiInteraction(interaction, {
    model: "gemini-3.6-flash",
    registry,
    stateEnvelope,
    clientId: "client",
    request: { tools: [] },
    now: () => 1000,
  });

  assert.equal(response.status, "completed");
  const message = response.output.find((item) => item.type === "message");
  assert.equal(message.content[0].annotations[0].url, "https://example.com");
  const call = response.output.find((item) => item.type === "function_call");
  assert.equal(call.namespace, "files");
  assert.equal(call.name, "read");
  assert.equal(call.call_id, "call_1");
  assert.equal(response.usage.output_tokens, 10);
  assert.equal(response.usage.input_tokens_details.cached_tokens, 4);
  assert.equal(response.usage.output_tokens_details.reasoning_tokens, 2);

  const state = response.output.find((item) => item.encrypted_content);
  const opened = stateEnvelope.open(state.encrypted_content, "client");
  assert.deepEqual(opened.steps, interaction.steps);
  assert.equal(opened.calls.call_1.namespace, "files");
});

test("custom tool calls restore raw custom input", () => {
  const registry = buildToolRegistry([{ type: "custom", name: "apply_patch" }]);
  const response = translateGeminiInteraction(
    {
      status: "requires_action",
      steps: [
        {
          type: "function_call",
          name: "apply_patch",
          arguments: { input: "*** Begin Patch" },
          id: "custom_1",
        },
      ],
      usage: {},
    },
    {
      model: "gemini-3.6-flash",
      registry,
      stateEnvelope,
      clientId: "client",
    }
  );
  const call = response.output.find((item) => item.type === "custom_tool_call");
  assert.equal(call.name, "apply_patch");
  assert.equal(call.input, "*** Begin Patch");
});

test("parallel function calls retain distinct IDs and argument payloads", () => {
  const registry = buildToolRegistry([
    { type: "function", name: "first", parameters: { type: "object" } },
    { type: "function", name: "second", parameters: { type: "object" } },
  ]);
  const response = translateGeminiInteraction(
    {
      status: "requires_action",
      steps: [
        { type: "function_call", name: "first", arguments: { value: 1 }, id: "call_a" },
        { type: "function_call", name: "second", arguments: { value: 2 }, id: "call_b" },
      ],
      usage: {},
    },
    { model: "gemini-3.6-flash", registry, stateEnvelope, clientId: "client" }
  );
  const calls = response.output.filter((item) => item.type === "function_call");
  assert.deepEqual(
    calls.map((call) => [call.call_id, call.name, call.arguments]),
    [
      ["call_a", "first", "{\"value\":1}"],
      ["call_b", "second", "{\"value\":2}"],
    ]
  );
});

test("streaming emits monotonically sequenced deltas and a terminal event", () => {
  const events = [];
  const adapter = new ResponsesStreamAdapter({
    model: "gemini-3.6-flash",
    registry: buildToolRegistry([]),
    stateEnvelope,
    clientId: "client",
    emit: (event) => events.push(event),
    now: () => 1000,
  });
  adapter.handle({ event_type: "interaction.created", interaction: { status: "in_progress" } });
  adapter.handle({ event_type: "step.start", index: 0, step: { type: "model_output" } });
  adapter.handle({ event_type: "step.delta", index: 0, delta: { type: "text", text: "hel" } });
  adapter.handle({ event_type: "step.delta", index: 0, delta: { type: "text", text: "lo" } });
  adapter.handle({ event_type: "step.stop", index: 0 });
  adapter.handle({
    event_type: "interaction.completed",
    interaction: {
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "hello" }] }],
      usage: { total_input_tokens: 1, total_output_tokens: 1 },
    },
  });

  assert.deepEqual(
    events.map((event) => event.sequence_number),
    events.map((_, index) => index)
  );
  assert.deepEqual(
    events.filter((event) => event.type === "response.output_text.delta").map((event) => event.delta),
    ["hel", "lo"]
  );
  assert.equal(events.at(-1).type, "response.completed");
});

test("Google Search emits a Responses lifecycle and preserves signed search state", () => {
  const events = [];
  const adapter = new ResponsesStreamAdapter({
    model: "gemini-3.6-flash",
    registry: buildToolRegistry([{ type: "web_search" }]),
    stateEnvelope,
    clientId: "client",
    emit: (event) => events.push(event),
  });
  const steps = [
    {
      type: "google_search_call",
      id: "search_1",
      arguments: { query: "Gemini docs" },
      signature: "search-signature",
    },
    {
      type: "google_search_result",
      call_id: "search_1",
      result: [{ title: "Docs", url: "https://ai.google.dev", snippet: "Gemini" }],
      signature: "result-signature",
    },
  ];
  adapter.handle({ event_type: "step.start", index: 0, step: { type: "google_search_call" } });
  adapter.handle({
    event_type: "step.delta",
    index: 0,
    delta: {
      type: "google_search_call",
      arguments: { query: "Gemini docs" },
      signature: "search-signature",
    },
  });
  adapter.handle({ event_type: "step.stop", index: 0, step: steps[0] });
  adapter.handle({
    event_type: "interaction.completed",
    interaction: { status: "completed", steps, usage: {} },
  });

  assert.ok(events.some((event) => event.type === "response.web_search_call.in_progress"));
  assert.ok(events.some((event) => event.type === "response.web_search_call.completed"));
  const stateItem = adapter.finalResponse.output.find((item) => item.encrypted_content);
  assert.deepEqual(stateEnvelope.open(stateItem.encrypted_content, "client").steps, steps);
});
