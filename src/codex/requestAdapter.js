import crypto from "crypto";
import { getCodexModel } from "./modelCatalog.js";

const SAFE_TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const SUPPORTED_IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export class ResponsesRequestError extends Error {
  constructor(code, message, param = null, status = 400) {
    super(message);
    this.name = "ResponsesRequestError";
    this.code = code;
    this.param = param;
    this.status = status;
  }
}

function bad(code, message, param = null) {
  throw new ResponsesRequestError(code, message, param);
}

function shortHash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 10);
}

function safeToolName(value, prefix, used) {
  const original = String(value || "");
  let candidate = original;
  if (!SAFE_TOOL_NAME.test(candidate)) {
    const stem = `${prefix}_${original}`
      .replace(/[^A-Za-z0-9_]/g, "_")
      .replace(/^[^A-Za-z_]+/, "")
      .slice(0, 52);
    candidate = `${stem || prefix}_${shortHash(original)}`.slice(0, 64);
  }
  if (used.has(candidate)) {
    const suffix = `_${shortHash(`${prefix}:${original}`)}`;
    candidate = `${candidate.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function toolParameters(parameters) {
  if (!parameters || typeof parameters !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  return parameters;
}

export function buildToolRegistry(tools = []) {
  if (!Array.isArray(tools)) bad("invalid_tools", "The tools field must be an array.", "tools");

  const used = new Set();
  const geminiTools = [];
  const byGeminiName = new Map();
  const byCodexIdentity = new Map();
  let hasGoogleSearch = false;

  function addFunction({ source, codexKind, codexName, namespace = null, description, parameters }) {
    const identity = namespace ? `${namespace}.${codexName}` : codexName;
    const prefix = namespace ? `${namespace}_${codexName}` : codexName || "tool";
    const geminiName = safeToolName(source || identity, prefix, used);
    const metadata = { kind: codexKind, name: codexName, namespace, geminiName };
    byGeminiName.set(geminiName, metadata);
    byCodexIdentity.set(identity, metadata);
    geminiTools.push({
      type: "function",
      name: geminiName,
      description: String(description || ""),
      parameters: toolParameters(parameters),
    });
  }

  for (const tool of tools) {
    if (!tool || typeof tool !== "object") bad("invalid_tool", "Every tool must be an object.", "tools");
    const type = String(tool.type || "");

    if (type === "function") {
      if (!tool.name) bad("invalid_tool", "Function tools require a name.", "tools");
      addFunction({
        source: tool.name,
        codexKind: "function",
        codexName: String(tool.name),
        description: tool.description,
        parameters: tool.parameters,
      });
      continue;
    }

    if (type === "namespace") {
      if (!tool.name || !Array.isArray(tool.tools)) {
        bad("invalid_tool", "Namespace tools require a name and nested tools.", "tools");
      }
      for (const inner of tool.tools) {
        if (!inner?.name) bad("invalid_tool", "Namespace functions require a name.", "tools");
        const namespace = String(tool.name);
        const innerName = String(inner.name);
        addFunction({
          source: `${namespace}__${innerName}`,
          codexKind: "namespace",
          codexName: innerName,
          namespace,
          description: inner.description || tool.description,
          parameters: inner.parameters,
        });
      }
      continue;
    }

    if (type === "custom") {
      if (!tool.name) bad("invalid_tool", "Custom tools require a name.", "tools");
      addFunction({
        source: tool.name,
        codexKind: "custom",
        codexName: String(tool.name),
        description: tool.description,
        parameters: {
          type: "object",
          properties: { input: { type: "string", description: "The raw input for this custom tool." } },
          required: ["input"],
          additionalProperties: false,
        },
      });
      continue;
    }

    if (type === "web_search" || type === "web_search_preview") {
      if (!hasGoogleSearch) {
        geminiTools.push({ type: "google_search", search_types: ["web_search"] });
        hasGoogleSearch = true;
      }
      continue;
    }

    bad(
      "unsupported_tool_type",
      `Tool type "${type || "unknown"}" is not supported by this gateway.`,
      "tools"
    );
  }

  return {
    geminiTools,
    byGeminiName,
    byCodexIdentity,
    hasGoogleSearch,
    serialize() {
      return Object.fromEntries(byGeminiName.entries());
    },
  };
}

function parseDataImage(url) {
  if (typeof url !== "string") {
    bad("unsupported_input_type", "Image inputs must use a base64 data URI.", "input");
  }
  if (!url.startsWith("data:")) {
    bad(
      "unsupported_remote_image",
      "Remote image URLs are not fetched by this gateway; use a base64 data URI.",
      "input"
    );
  }
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=_-]+)$/i.exec(url);
  if (!match || !SUPPORTED_IMAGE_MIME.has(match[1].toLowerCase())) {
    bad(
      "unsupported_image",
      "Images must be base64 data URIs using PNG, JPEG, WebP, or GIF.",
      "input"
    );
  }
  return { type: "image", mime_type: match[1].toLowerCase(), data: match[2] };
}

function mapMessageContent(content, { developer = false } = {}) {
  const blocks = typeof content === "string" ? [{ type: "input_text", text: content }] : content;
  if (!Array.isArray(blocks)) bad("invalid_input", "Message content must be text or an array.", "input");
  const mapped = [];

  for (const block of blocks) {
    if (typeof block === "string") {
      mapped.push({ type: "text", text: block });
      continue;
    }
    const type = String(block?.type || "");
    if (type === "input_text" || type === "output_text" || type === "text") {
      mapped.push({ type: "text", text: String(block.text || "") });
      continue;
    }
    if (type === "input_image") {
      if (developer) bad("unsupported_input_type", "Developer messages cannot contain images.", "input");
      mapped.push(parseDataImage(block.image_url));
      continue;
    }
    if (type.includes("audio") || type === "input_file" || type === "file") {
      bad(
        "unsupported_input_type",
        `Input content type "${type}" is not supported by this gateway.`,
        "input"
      );
    }
    bad("unsupported_input_type", `Input content type "${type || "unknown"}" is not supported.`, "input");
  }
  return mapped;
}

function contentText(content) {
  return mapMessageContent(content, { developer: true })
    .map((block) => block.text)
    .join("\n");
}

function parseArguments(value) {
  if (value && typeof value === "object") return value;
  try {
    return JSON.parse(String(value || "{}"));
  } catch {
    bad("invalid_tool_arguments", "Function-call arguments must be valid JSON.", "input");
  }
}

function resultContent(value) {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (Array.isArray(value)) {
    const text = value
      .map((part) => {
        if (typeof part === "string") return part;
        if (part?.type === "input_text" || part?.type === "output_text" || part?.type === "text") {
          return String(part.text || "");
        }
        return JSON.stringify(part);
      })
      .join("\n");
    return [{ type: "text", text }];
  }
  return [{ type: "text", text: JSON.stringify(value ?? "") }];
}

function normalizeToolChoice(toolChoice, registry) {
  if (toolChoice === undefined || toolChoice === null) return "auto";
  if (typeof toolChoice === "string") {
    if (toolChoice === "required") return "any";
    if (["auto", "none"].includes(toolChoice)) return toolChoice;
    bad("unsupported_tool_choice", `Unsupported tool_choice "${toolChoice}".`, "tool_choice");
  }
  if (typeof toolChoice !== "object") {
    bad("unsupported_tool_choice", "tool_choice must be auto, required, none, or a tool object.", "tool_choice");
  }

  const identity = toolChoice.namespace
    ? `${toolChoice.namespace}.${toolChoice.name || toolChoice.tool_name}`
    : toolChoice.name;
  const match = registry.byCodexIdentity.get(String(identity || ""));
  if (!match) bad("unknown_tool_choice", "tool_choice refers to an unknown tool.", "tool_choice");
  return { allowed_tools: { mode: "any", tools: [match.geminiName] } };
}

function mapResponseFormat(text) {
  const format = text?.format;
  if (!format || format.type === "text") return null;
  if (format.type === "json_object") {
    return { type: "text", mime_type: "application/json" };
  }
  if (format.type === "json_schema") {
    if (!format.schema || typeof format.schema !== "object") {
      bad("invalid_response_format", "A JSON schema response format requires schema.", "text.format");
    }
    return { type: "text", mime_type: "application/json", schema: format.schema };
  }
  bad(
    "unsupported_response_format",
    `Response format "${format.type || "unknown"}" is not supported.`,
    "text.format"
  );
}

function restoredCallMap(statePayloads) {
  const calls = new Map();
  for (const payload of statePayloads) {
    for (const [callId, metadata] of Object.entries(payload.calls || {})) {
      calls.set(callId, metadata);
    }
  }
  return calls;
}

export function adaptResponsesRequest(body, { clientId, stateEnvelope }) {
  if (!body || typeof body !== "object") bad("invalid_request", "A JSON request body is required.");
  if (body.store === true) {
    bad("unsupported_stateful_feature", "store: true is not supported; this gateway is stateless.", "store");
  }
  if (body.background === true) {
    bad("unsupported_stateful_feature", "background responses are not supported.", "background");
  }
  if (body.previous_response_id) {
    bad(
      "unsupported_stateful_feature",
      "previous_response_id is not supported; replay encrypted reasoning content instead.",
      "previous_response_id"
    );
  }

  const model = getCodexModel(body.model);
  if (!model) bad("model_not_found", `Model "${body.model || ""}" is not available.`, "model", 404);
  const registry = buildToolRegistry(body.tools || []);
  const input = typeof body.input === "string" ? body.input : body.input || [];
  const items =
    typeof input === "string" ? [{ role: "user", content: input }] : Array.isArray(input) ? input : null;
  if (!items) bad("invalid_input", "input must be text or an array of Responses input items.", "input");

  const decodedByItem = new Map();
  const statePayloads = [];
  for (const item of items) {
    if (item?.type === "reasoning" && item.encrypted_content) {
      const payload = stateEnvelope.open(item.encrypted_content, clientId);
      decodedByItem.set(item, payload);
      statePayloads.push(payload);
    }
  }

  const coveredItemIds = new Set(
    statePayloads.flatMap((payload) => (Array.isArray(payload.coveredItemIds) ? payload.coveredItemIds : []))
  );
  const priorCalls = restoredCallMap(statePayloads);
  const geminiInput = [];
  const developerInstructions = [];
  if (body.instructions) developerInstructions.push(String(body.instructions));

  for (const item of items) {
    const state = decodedByItem.get(item);
    if (state) {
      geminiInput.push(...state.steps);
      continue;
    }

    if (!item || typeof item !== "object") {
      geminiInput.push({ type: "user_input", content: [{ type: "text", text: String(item ?? "") }] });
      continue;
    }
    if (item.id && coveredItemIds.has(item.id)) continue;

    if (item.role === "developer" || item.role === "system") {
      developerInstructions.push(contentText(item.content));
      continue;
    }
    if (item.role === "user") {
      geminiInput.push({ type: "user_input", content: mapMessageContent(item.content) });
      continue;
    }
    if (item.role === "assistant") {
      geminiInput.push({ type: "model_output", content: mapMessageContent(item.content) });
      continue;
    }

    if (item.type === "message") {
      if (item.role === "developer" || item.role === "system") {
        developerInstructions.push(contentText(item.content));
      } else if (item.role === "assistant") {
        geminiInput.push({ type: "model_output", content: mapMessageContent(item.content) });
      } else {
        geminiInput.push({ type: "user_input", content: mapMessageContent(item.content) });
      }
      continue;
    }

    if (item.type === "function_call" || item.type === "custom_tool_call") {
      const identity = item.namespace ? `${item.namespace}.${item.name}` : item.name;
      const mapped = registry.byCodexIdentity.get(String(identity || ""));
      const prior = priorCalls.get(item.call_id);
      const geminiName = prior?.geminiName || mapped?.geminiName || item.name;
      geminiInput.push({
        type: "function_call",
        name: geminiName,
        arguments:
          item.type === "custom_tool_call"
            ? { input: String(item.input || "") }
            : parseArguments(item.arguments),
        id: item.call_id || item.id,
      });
      continue;
    }

    if (item.type === "function_call_output" || item.type === "custom_tool_call_output") {
      const prior = priorCalls.get(item.call_id);
      if (!prior) {
        bad(
          "missing_state_envelope",
          `No encrypted state was supplied for tool call "${item.call_id || ""}".`,
          "input"
        );
      }
      geminiInput.push({
        type: "function_result",
        name: prior.geminiName,
        call_id: item.call_id,
        result: resultContent(item.output),
      });
      continue;
    }

    if (item.type === "reasoning") continue;
    if (item.type === "web_search_call") continue;
    bad("unsupported_input_type", `Input item type "${item.type || "unknown"}" is not supported.`, "input");
  }

  if (geminiInput.length === 0) bad("invalid_input", "At least one user input item is required.", "input");

  const effort = body.reasoning?.effort || model.default_reasoning_level;
  if (!model.supported_reasoning_levels.some((level) => level.effort === effort)) {
    bad(
      "unsupported_reasoning_effort",
      `Reasoning effort "${effort}" is not supported by ${model.slug}.`,
      "reasoning.effort"
    );
  }

  const generationConfig = {
    thinking_level: effort,
    thinking_summaries: body.reasoning?.summary === "none" ? "none" : "auto",
    tool_choice: normalizeToolChoice(body.tool_choice, registry),
  };
  if (Number.isInteger(body.max_output_tokens) && body.max_output_tokens > 0) {
    generationConfig.max_output_tokens = body.max_output_tokens;
  }

  const geminiRequest = {
    model: model.slug,
    input: geminiInput,
    stream: body.stream === true,
    store: false,
    generation_config: generationConfig,
  };
  const systemInstruction = developerInstructions.filter(Boolean).join("\n\n");
  if (systemInstruction) geminiRequest.system_instruction = systemInstruction;
  if (registry.geminiTools.length > 0) geminiRequest.tools = registry.geminiTools;
  const responseFormat = mapResponseFormat(body.text);
  if (responseFormat) geminiRequest.response_format = responseFormat;

  return {
    geminiRequest,
    registry,
    model,
    stream: body.stream === true,
    statePayloads,
  };
}
