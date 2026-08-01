import assert from "node:assert/strict";
import test from "node:test";
import {
  adaptResponsesRequest,
  ResponsesRequestError,
} from "../../src/codex/requestAdapter.js";
import { createStateEnvelope } from "../../src/codex/stateEnvelope.js";

const stateEnvelope = createStateEnvelope({ secret: "33".repeat(32) });

function adapt(body, clientId = "client") {
  return adaptResponsesRequest(body, { clientId, stateEnvelope });
}

test("developer, user text, images, reasoning, JSON schema, and tools map to Interactions", () => {
  const result = adapt({
    model: "gemini-3.6-flash",
    instructions: "Global instruction",
    input: [
      { role: "developer", content: "Developer instruction" },
      {
        role: "user",
        content: [
          { type: "input_text", text: "Describe this" },
          { type: "input_image", image_url: "data:image/png;base64,aGVsbG8=" },
        ],
      },
    ],
    reasoning: { effort: "high", summary: "auto" },
    max_output_tokens: 123,
    temperature: 0.1,
    top_p: 0.2,
    text: {
      format: {
        type: "json_schema",
        name: "answer",
        strict: true,
        schema: { type: "object", properties: { answer: { type: "string" } } },
      },
    },
    tools: [
      {
        type: "function",
        name: "read_file",
        description: "Read a file",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
      {
        type: "namespace",
        name: "workspace",
        tools: [{ name: "search-files", parameters: { type: "object" } }],
      },
      { type: "custom", name: "apply_patch", description: "Apply a patch" },
      { type: "web_search" },
    ],
  });

  assert.equal(result.geminiRequest.store, false);
  assert.equal(result.geminiRequest.system_instruction, "Global instruction\n\nDeveloper instruction");
  assert.deepEqual(result.geminiRequest.input[0], {
    type: "user_input",
    content: [
      { type: "text", text: "Describe this" },
      { type: "image", mime_type: "image/png", data: "aGVsbG8=" },
    ],
  });
  assert.equal(result.geminiRequest.generation_config.thinking_level, "high");
  assert.equal(result.geminiRequest.generation_config.max_output_tokens, 123);
  assert.equal(result.geminiRequest.temperature, undefined);
  assert.equal(result.geminiRequest.top_p, undefined);
  assert.equal(result.geminiRequest.response_format.mime_type, "application/json");
  assert.equal(result.geminiRequest.tools.filter((tool) => tool.type === "function").length, 3);
  assert.ok(result.geminiRequest.tools.some((tool) => tool.type === "google_search"));
  assert.ok(
    result.geminiRequest.tools.every(
      (tool) => tool.type !== "function" || /^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(tool.name)
    )
  );
});

test("custom and namespace tool choice identities map to allowed Gemini names", () => {
  const body = {
    model: "gemini-3.6-flash",
    input: "go",
    tools: [
      { type: "function", name: "plain", parameters: { type: "object" } },
      {
        type: "namespace",
        name: "ns",
        tools: [{ name: "inside", parameters: { type: "object" } }],
      },
    ],
    tool_choice: { type: "function", name: "plain" },
  };
  const result = adapt(body);
  assert.deepEqual(result.geminiRequest.generation_config.tool_choice, {
    allowed_tools: { mode: "any", tools: ["plain"] },
  });
});

test("assistant history becomes Gemini model output when no encrypted state is needed", () => {
  const result = adapt({
    model: "gemini-3.6-flash",
    input: [
      { role: "user", content: "first" },
      { role: "assistant", content: [{ type: "output_text", text: "answer" }] },
      { role: "user", content: "follow-up" },
    ],
  });
  assert.deepEqual(
    result.geminiRequest.input.map((step) => step.type),
    ["user_input", "model_output", "user_input"]
  );
  assert.equal(result.geminiRequest.input[1].content[0].text, "answer");
});

test("encrypted state restores exact thought/tool steps and inserts function results", () => {
  const rawSteps = [
    { type: "thought", signature: "sig", summary: [{ type: "text", text: "summary" }] },
    { type: "function_call", name: "gemini_flat_name", arguments: { path: "a" }, id: "call_1" },
  ];
  const token = stateEnvelope.seal(
    {
      version: 1,
      steps: rawSteps,
      coveredItemIds: ["fc_visible"],
      calls: {
        call_1: {
          kind: "namespace",
          name: "read",
          namespace: "files",
          geminiName: "gemini_flat_name",
        },
      },
    },
    "client"
  );
  const result = adapt({
    model: "gemini-3.6-flash",
    input: [
      {
        id: "fc_visible",
        type: "function_call",
        namespace: "files",
        name: "read",
        call_id: "call_1",
        arguments: "{\"path\":\"a\"}",
      },
      { type: "reasoning", encrypted_content: token, summary: [] },
      { type: "function_call_output", call_id: "call_1", output: "contents" },
    ],
    tools: [],
  });
  assert.deepEqual(result.geminiRequest.input.slice(0, 2), rawSteps);
  assert.deepEqual(result.geminiRequest.input[2], {
    type: "function_result",
    name: "gemini_flat_name",
    call_id: "call_1",
    result: [{ type: "text", text: "contents" }],
  });
});

test("unsupported stateful features, inputs, tools, and model efforts fail explicitly", () => {
  const base = { model: "gemini-3.6-flash", input: "hello" };
  for (const patch of [
    { store: true },
    { background: true },
    { previous_response_id: "resp_old" },
  ]) {
    assert.throws(() => adapt({ ...base, ...patch }), ResponsesRequestError);
  }
  assert.throws(
    () =>
      adapt({
        ...base,
        input: [
          {
            role: "user",
            content: [{ type: "input_image", image_url: "https://example.com/image.png" }],
          },
        ],
      }),
    (error) => error.code === "unsupported_remote_image"
  );
  assert.throws(
    () => adapt({ ...base, tools: [{ type: "file_search" }] }),
    (error) => error.code === "unsupported_tool_type"
  );
  assert.throws(
    () => adapt({ ...base, reasoning: { effort: "minimal" }, model: "gemini-3.1-pro-preview-customtools" }),
    (error) => error.code === "unsupported_reasoning_effort"
  );
});
