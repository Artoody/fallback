import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { Readable } from "node:stream";
import { Response } from "node-fetch";
import createApp from "../src/app.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "fallback-codex-"));
const codexHome = path.join(root, "codex-home");
const dataDir = path.join(root, "data");
const toyDir = path.join(root, "toy-repo");
fs.mkdirSync(codexHome, { recursive: true });
fs.mkdirSync(toyDir, { recursive: true });
let lastToolSummary = [];

function interactionForRequest(request) {
  const toolResults = request.input.filter((step) => step.type === "function_result");
  const functions = (request.tools || []).filter((tool) => tool.type === "function");
  lastToolSummary = (request.tools || []).map((tool) => ({
    type: tool.type,
    name: tool.name,
    properties: Object.keys(tool.parameters?.properties || {}),
  }));
  const patchTool =
    functions.find((tool) => /apply_patch/i.test(tool.name)) ||
    functions.find((tool) => tool.name === "exec");
  const shellTool =
    functions.find((tool) => /(shell|command)/i.test(tool.name)) ||
    functions.find((tool) => tool.name === "exec");

  if (JSON.stringify(request.input).includes("MOCK_TOOL_LOOP")) {
    if (toolResults.length === 0) {
      if (!patchTool) throw new Error("Codex did not expose its custom apply_patch tool.");
      return {
        status: "requires_action",
        steps: [
          {
            type: "thought",
            signature: "mock-thought-signature-1",
            summary: [{ type: "text", text: "Create the test artifact." }],
          },
          {
            type: "function_call",
            name: patchTool.name,
            arguments: {
              input: patchTool.name === "exec"
                ? 'const r = await tools.apply_patch("*** Begin Patch\\n*** Add File: gateway-artifact.txt\\n+codex gateway tool loop\\n*** End Patch"); text(JSON.stringify(r))'
                : "*** Begin Patch\n*** Add File: gateway-artifact.txt\n+codex gateway tool loop\n*** End Patch",
            },
            id: "mock_patch_call",
          },
        ],
        usage: { total_input_tokens: 20, total_output_tokens: 5, total_thought_tokens: 2 },
      };
    }
    if (toolResults.length === 1) {
      if (!shellTool) throw new Error("Codex did not expose a shell tool.");
      const command = "test -f gateway-artifact.txt && grep -q 'codex gateway tool loop' gateway-artifact.txt";
      const properties = shellTool.parameters?.properties || {};
      const argumentsValue =
        shellTool.name === "exec"
          ? {
              input: `const r = await tools.exec_command({cmd:${JSON.stringify(command)}}); text(JSON.stringify(r))`,
            }
          : properties.cmd
            ? { cmd: command }
            : properties.command?.type === "array"
              ? { command: [command] }
              : properties.command
                ? { command }
                : properties.input
                  ? { input: command }
                  : null;
      if (!argumentsValue) throw new Error(`Unsupported shell schema for ${shellTool.name}.`);
      return {
        status: "requires_action",
        steps: [
          {
            type: "thought",
            signature: "mock-thought-signature-2",
            summary: [{ type: "text", text: "Verify the created artifact." }],
          },
          {
            type: "function_call",
            name: shellTool.name,
            arguments: argumentsValue,
            id: "mock_shell_call",
          },
        ],
        usage: { total_input_tokens: 30, total_output_tokens: 5, total_thought_tokens: 2 },
      };
    }
    return {
      status: "completed",
      steps: [{ type: "model_output", content: [{ type: "text", text: "CODEX_TOOL_LOOP_OK" }] }],
      usage: { total_input_tokens: 40, total_output_tokens: 4 },
    };
  }

  return {
    status: "completed",
    steps: [
      {
        type: "model_output",
        content: [{ type: "text", text: "CODEX_GATEWAY_OK" }],
      },
    ],
    usage: { total_input_tokens: 10, total_output_tokens: 3 },
  };
}

const runtime = createApp({
  env: {
    DATA_DIR: dataDir,
    GEMINI_API_KEYS: "mock-gemini-key",
    PROXY_API_KEY: "mock-codex-client",
    ADMIN_PASSWORD: "mock-admin",
    RESPONSES_STATE_SECRET: "77".repeat(32),
    GOOGLE_BASE_URL: "https://mock.invalid",
  },
  fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const interaction = interactionForRequest(request);
    if (!request.stream) {
      return new Response(JSON.stringify(interaction), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const frames = [
      { event_type: "interaction.created", interaction: { status: "in_progress" } },
      ...interaction.steps.flatMap((step, index) => {
        const deltas =
          step.type === "model_output"
            ? [{ type: "text", text: step.content[0].text }]
            : step.type === "thought"
              ? [
                  { type: "thought_summary", content: step.summary[0] },
                  { type: "thought_signature", signature: step.signature },
                ]
              : step.type === "function_call"
                ? [{ type: "arguments_delta", arguments: JSON.stringify(step.arguments) }]
                : [];
        return [
          {
            event_type: "step.start",
            index,
            step: { type: step.type, name: step.name, id: step.id },
          },
          ...deltas.map((delta) => ({ event_type: "step.delta", index, delta })),
          { event_type: "step.stop", index },
        ];
      }),
      { event_type: "interaction.completed", interaction },
    ];
    return new Response(
      Readable.from(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).concat("data: [DONE]\n\n")),
      { status: 200, headers: { "Content-Type": "text/event-stream" } }
    );
  },
  logger: { log() {}, warn() {}, error() {} },
});

const server = await new Promise((resolve) => {
  const listening = runtime.app.listen(0, "127.0.0.1", () => resolve(listening));
});
const port = server.address().port;
const config = `model = "gemini-3.6-flash"
model_provider = "gemini_pool"
model_reasoning_effort = "medium"

[model_providers.gemini_pool]
name = "Gemini Pool"
base_url = "http://127.0.0.1:${port}/v1"
wire_api = "responses"
request_max_retries = 0
stream_max_retries = 0
stream_idle_timeout_ms = 300000
supports_websockets = false

[model_providers.gemini_pool.auth]
command = "/bin/echo"
args = ["mock-codex-client"]
timeout_ms = 5000
refresh_interval_ms = 0
`;
fs.writeFileSync(path.join(codexHome, "config.toml"), config, { mode: 0o600 });
fs.writeFileSync(path.join(codexHome, "mock.config.toml"), config, { mode: 0o600 });

function runCodex(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("codex", args, {
      cwd: process.cwd(),
      env: { ...process.env, CODEX_HOME: codexHome },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Codex compatibility test timed out."));
    }, 60_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

try {
  const result = await runCodex(["debug", "models"]);
  if (result.code !== 0) throw new Error(`Codex exited ${result.code}: ${result.stderr.trim()}`);
  if (/degraded|missing metadata|warning/i.test(result.stderr)) {
    throw new Error(`Codex reported a model-catalog warning: ${result.stderr.trim()}`);
  }
  const catalog = JSON.parse(result.stdout);
  const models = Array.isArray(catalog) ? catalog : catalog.models;
  const slugs = models.map((model) => model.slug);
  for (const expected of ["gemini-3.6-flash", "gemini-3.1-pro-preview-customtools"]) {
    if (!slugs.includes(expected)) throw new Error(`Codex did not load ${expected}.`);
  }
  const execution = await runCodex([
    "--profile",
    "mock",
    "exec",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "Reply with exactly CODEX_GATEWAY_OK.",
  ]);
  if (execution.code !== 0) {
    throw new Error(`Codex Responses execution exited ${execution.code}: ${execution.stderr.trim()}`);
  }
  if (!execution.stdout.includes("CODEX_GATEWAY_OK")) {
    throw new Error("Codex did not consume the streamed Responses output.");
  }
  if (/degraded|missing metadata/i.test(execution.stderr)) {
    throw new Error(`Codex reported a compatibility warning: ${execution.stderr.trim()}`);
  }
  const toolLoop = await new Promise((resolve, reject) => {
    const child = spawn(
      "codex",
      [
        "--profile",
        "mock",
        "--ask-for-approval",
        "never",
        "--sandbox",
        "workspace-write",
        "exec",
        "--skip-git-repo-check",
        "--color",
        "never",
        "MOCK_TOOL_LOOP: create and verify the requested artifact, then finish.",
      ],
      {
        cwd: toyDir,
        env: { ...process.env, CODEX_HOME: codexHome },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("Codex tool-loop test timed out."));
    }, 60_000);
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
  if (toolLoop.code !== 0 || !toolLoop.stdout.includes("CODEX_TOOL_LOOP_OK")) {
    throw new Error(
      `Codex tool loop failed (${toolLoop.code}); tools=${JSON.stringify(lastToolSummary)}: ${
        toolLoop.stderr.trim() || toolLoop.stdout.trim()
      }`
    );
  }
  if (!fs.readFileSync(path.join(toyDir, "gateway-artifact.txt"), "utf8").includes("tool loop")) {
    throw new Error("Codex did not apply the custom tool edit.");
  }
  console.log(
    `Codex ${slugs.filter((slug) => slug.startsWith("gemini-")).join(", ")} catalog, streaming, and edit/test tool-loop validation passed.`
  );
} finally {
  await new Promise((resolve) => server.close(resolve));
  runtime.close();
  fs.rmSync(root, { recursive: true, force: true });
}
