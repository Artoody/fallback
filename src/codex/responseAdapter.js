import crypto from "crypto";

function id(prefix) {
  return `${prefix}_${crypto.randomBytes(12).toString("hex")}`;
}

function asJson(value) {
  if (typeof value === "string") return value;
  return JSON.stringify(value ?? {});
}

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function mapAnnotations(annotations = []) {
  return annotations
    .filter((annotation) => annotation?.type === "url_citation" && annotation.url)
    .map((annotation) => ({
      type: "url_citation",
      start_index: Number(annotation.start_index || 0),
      end_index: Number(annotation.end_index || annotation.start_index || 0),
      title: String(annotation.title || annotation.url),
      url: String(annotation.url),
    }));
}

export function mapGeminiUsage(usage = {}) {
  const inputTokens = Number(usage.total_input_tokens || 0);
  const cachedTokens = Number(usage.total_cached_tokens || 0);
  const visibleOutput = Number(usage.total_output_tokens || 0);
  const thoughtTokens = Number(usage.total_thought_tokens || 0);
  const toolTokens = Number(usage.total_tool_use_tokens || 0);
  const outputTokens = visibleOutput + thoughtTokens + toolTokens;
  return {
    input_tokens: inputTokens,
    input_tokens_details: { cached_tokens: cachedTokens },
    output_tokens: outputTokens,
    output_tokens_details: { reasoning_tokens: thoughtTokens },
    total_tokens: inputTokens + outputTokens,
  };
}

export function responsesUsageToStoreUsage(usage) {
  if (!usage) return null;
  return {
    promptTokenCount: Number(usage.input_tokens || 0),
    candidatesTokenCount: Number(usage.output_tokens || 0),
    totalTokenCount: Number(usage.total_tokens || 0),
  };
}

function responseStatus(status) {
  if (status === "incomplete" || status === "budget_exceeded") return "incomplete";
  if (status === "failed" || status === "cancelled") return "failed";
  return "completed";
}

function responseError(interaction) {
  if (responseStatus(interaction?.status) !== "failed") return null;
  const upstream = interaction?.error;
  return {
    code: String(upstream?.code || "upstream_failed"),
    message: String(upstream?.message || "Gemini failed to complete the response."),
  };
}

function baseResponse({ responseId, model, createdAt, request, status = "in_progress" }) {
  return {
    id: responseId,
    object: "response",
    created_at: createdAt,
    status,
    background: false,
    error: null,
    incomplete_details: null,
    instructions: request?.instructions ?? null,
    max_output_tokens: request?.max_output_tokens ?? null,
    max_tool_calls: request?.max_tool_calls ?? null,
    model,
    output: [],
    parallel_tool_calls: request?.parallel_tool_calls !== false,
    previous_response_id: null,
    prompt_cache_key: request?.prompt_cache_key ?? null,
    reasoning: request?.reasoning ?? null,
    safety_identifier: null,
    service_tier: "default",
    store: false,
    temperature: null,
    text: request?.text || { format: { type: "text" } },
    tool_choice: request?.tool_choice || "auto",
    tools: request?.tools || [],
    top_logprobs: 0,
    top_p: null,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: request?.metadata || {},
  };
}

function generatedStep(step) {
  const type = step?.type;
  return (
    typeof type === "string" &&
    !["user_input", "function_result"].includes(type) &&
    (type === "thought" ||
      type === "model_output" ||
      type === "function_call" ||
      type === "google_search_call" ||
      type === "google_search_result" ||
      type.endsWith("_call") ||
      type.endsWith("_result"))
  );
}

function registryMetadata(registry, geminiName) {
  return registry?.byGeminiName?.get(geminiName) || {
    kind: "function",
    name: geminiName,
    namespace: null,
    geminiName,
  };
}

function mergeStep(target, source) {
  if (!source || typeof source !== "object") return target;
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && key !== "content" && key !== "summary") target[key] = clone(value);
  }
  return target;
}

export class ResponsesStreamAdapter {
  constructor({
    model,
    registry,
    stateEnvelope,
    clientId,
    request = {},
    emit,
    responseId = id("resp"),
    now = () => Date.now(),
  }) {
    this.model = model;
    this.registry = registry;
    this.stateEnvelope = stateEnvelope;
    this.clientId = clientId;
    this.request = request;
    this.emitCallback = emit || (() => {});
    this.responseId = responseId;
    this.createdAt = Math.floor(now() / 1000);
    this.sequence = 0;
    this.started = false;
    this.finished = false;
    this.steps = new Map();
    this.rawSteps = [];
    this.output = [];
    this.coveredItemIds = [];
    this.calls = {};
    this.interaction = null;
  }

  emit(type, payload = {}) {
    const event = { type, sequence_number: this.sequence++, ...payload };
    this.emitCallback(event);
    return event;
  }

  start() {
    if (this.started) return;
    this.started = true;
    const response = baseResponse({
      responseId: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      request: this.request,
    });
    this.emit("response.created", { response });
    this.emit("response.in_progress", { response });
  }

  addOutput(item) {
    const outputIndex = this.output.length;
    this.output.push(item);
    this.coveredItemIds.push(item.id);
    this.emit("response.output_item.added", { output_index: outputIndex, item: clone(item) });
    return outputIndex;
  }

  startStep(index, step = {}) {
    this.start();
    if (this.steps.has(index)) return this.steps.get(index);
    const type = step.type;
    const acc = {
      index,
      type,
      source: clone(step),
      raw: mergeStep({ type }, step),
      stopped: false,
      outputIndex: null,
      item: null,
      text: "",
      annotations: [],
      arguments: "",
      summary: "",
      summaryPartAdded: false,
    };

    if (type === "model_output") {
      acc.item = {
        id: id("msg"),
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [], logprobs: [] }],
      };
      acc.outputIndex = this.addOutput(acc.item);
      this.emit("response.content_part.added", {
        item_id: acc.item.id,
        output_index: acc.outputIndex,
        content_index: 0,
        part: clone(acc.item.content[0]),
      });
    } else if (type === "thought") {
      acc.item = { id: id("rs"), type: "reasoning", summary: [] };
      acc.outputIndex = this.addOutput(acc.item);
    } else if (type === "function_call") {
      const metadata = registryMetadata(this.registry, step.name);
      const callId = step.id || id("call");
      const common = {
        id: id("fc"),
        call_id: callId,
        name: metadata.name,
        status: "in_progress",
      };
      if (metadata.kind === "custom") {
        acc.item = { ...common, type: "custom_tool_call", input: "" };
      } else {
        acc.item = { ...common, type: "function_call", arguments: "" };
        if (metadata.kind === "namespace") acc.item.namespace = metadata.namespace;
      }
      acc.metadata = metadata;
      acc.outputIndex = this.addOutput(acc.item);
      this.calls[callId] = metadata;
    } else if (type === "google_search_call") {
      acc.item = {
        id: id("ws"),
        type: "web_search_call",
        status: "in_progress",
        action: { type: "search", query: "" },
      };
      acc.outputIndex = this.addOutput(acc.item);
      this.emit("response.web_search_call.in_progress", {
        output_index: acc.outputIndex,
        item_id: acc.item.id,
      });
    }

    this.steps.set(index, acc);
    this.applyInitialStep(acc, step);
    return acc;
  }

  applyInitialStep(acc, step) {
    if (acc.type === "model_output") {
      for (const block of step.content || []) {
        if (block?.type === "text") {
          this.applyDelta(acc, { type: "text", text: block.text || "" });
          if (block.annotations) {
            this.applyDelta(acc, { type: "text_annotation_delta", annotations: block.annotations });
          }
        }
      }
    } else if (acc.type === "thought") {
      for (const block of step.summary || []) {
        if (block?.type === "text") {
          this.applyDelta(acc, { type: "thought_summary", content: block });
        }
      }
      if (step.signature) this.applyDelta(acc, { type: "thought_signature", signature: step.signature });
    } else if (acc.type === "function_call" && step.arguments !== undefined) {
      this.applyDelta(acc, { type: "arguments_delta", arguments: asJson(step.arguments) });
    } else if (acc.type === "google_search_call" && step.arguments !== undefined) {
      acc.searchArguments = clone(step.arguments);
    }
  }

  applyDelta(acc, delta = {}) {
    if (!acc || acc.stopped) return;
    if (acc.type === "model_output" && delta.type === "text") {
      const text = String(delta.text || "");
      acc.text += text;
      acc.item.content[0].text = acc.text;
      if (text) {
        this.emit("response.output_text.delta", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          content_index: 0,
          delta: text,
          logprobs: [],
        });
      }
      return;
    }
    if (acc.type === "model_output" && delta.type === "text_annotation_delta") {
      const mapped = mapAnnotations(delta.annotations);
      for (const annotation of mapped) {
        acc.annotations.push(annotation);
        this.emit("response.output_text.annotation.added", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          content_index: 0,
          annotation_index: acc.annotations.length - 1,
          annotation,
        });
      }
      acc.item.content[0].annotations = acc.annotations;
      return;
    }
    if (acc.type === "thought" && delta.type === "thought_summary") {
      const text = String(delta.content?.text || "");
      if (!acc.summaryPartAdded) {
        acc.summaryPartAdded = true;
        acc.item.summary.push({ type: "summary_text", text: "" });
        this.emit("response.reasoning_summary_part.added", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        });
      }
      acc.summary += text;
      acc.item.summary[0].text = acc.summary;
      if (text) {
        this.emit("response.reasoning_summary_text.delta", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          summary_index: 0,
          delta: text,
        });
      }
      return;
    }
    if (acc.type === "thought" && delta.type === "thought_signature") {
      acc.raw.signature = delta.signature;
      return;
    }
    if (acc.type === "function_call" && delta.type === "arguments_delta") {
      const fragment = String(delta.arguments || "");
      acc.arguments += fragment;
      if (acc.metadata.kind !== "custom" && fragment) {
        this.emit("response.function_call_arguments.delta", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          delta: fragment,
        });
      }
      return;
    }
    if (acc.type === "google_search_call" && delta.type === "google_search_call") {
      acc.searchArguments = clone(delta.arguments || {});
      if (delta.signature) acc.raw.signature = delta.signature;
      return;
    }
    if (acc.type === "google_search_result" && delta.type === "google_search_result") {
      if (delta.call_id) acc.raw.call_id = delta.call_id;
      if (delta.result) acc.raw.result = clone(delta.result);
      if (delta.signature) acc.raw.signature = delta.signature;
      return;
    }
    if (delta.signature) acc.raw.signature = delta.signature;
  }

  deltaStep(index, delta) {
    const acc = this.steps.get(index) || this.startStep(index, { type: delta?.step_type || "unknown" });
    this.applyDelta(acc, delta);
  }

  stopStep(index, finalStep = null) {
    const acc = this.steps.get(index) || this.startStep(index, finalStep || {});
    if (acc.stopped) return;
    if (finalStep) mergeStep(acc.raw, finalStep);

    if (acc.type === "model_output") {
      acc.raw.content = finalStep?.content
        ? clone(finalStep.content)
        : [{ type: "text", text: acc.text, ...(acc.annotations.length ? { annotations: acc.annotations } : {}) }];
      acc.item.status = "completed";
      this.emit("response.output_text.done", {
        item_id: acc.item.id,
        output_index: acc.outputIndex,
        content_index: 0,
        text: acc.text,
        logprobs: [],
      });
      this.emit("response.content_part.done", {
        item_id: acc.item.id,
        output_index: acc.outputIndex,
        content_index: 0,
        part: clone(acc.item.content[0]),
      });
      this.emit("response.output_item.done", {
        output_index: acc.outputIndex,
        item: clone(acc.item),
      });
    } else if (acc.type === "thought") {
      acc.raw.summary = finalStep?.summary
        ? clone(finalStep.summary)
        : acc.summary
          ? [{ type: "text", text: acc.summary }]
          : [];
      if (acc.summaryPartAdded) {
        this.emit("response.reasoning_summary_text.done", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          summary_index: 0,
          text: acc.summary,
        });
        this.emit("response.reasoning_summary_part.done", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          summary_index: 0,
          part: clone(acc.item.summary[0]),
        });
      }
      this.emit("response.output_item.done", {
        output_index: acc.outputIndex,
        item: clone(acc.item),
      });
    } else if (acc.type === "function_call") {
      let parsedArguments;
      try {
        parsedArguments = finalStep?.arguments ?? JSON.parse(acc.arguments || "{}");
      } catch {
        parsedArguments = {};
      }
      acc.raw.name = finalStep?.name || acc.source.name;
      acc.raw.id = finalStep?.id || acc.item.call_id;
      acc.raw.arguments = clone(parsedArguments);
      acc.item.status = "completed";
      if (acc.metadata.kind === "custom") {
        const input = String(parsedArguments?.input ?? "");
        acc.item.input = input;
        if (input) {
          this.emit("response.custom_tool_call_input.delta", {
            item_id: acc.item.id,
            output_index: acc.outputIndex,
            delta: input,
          });
        }
        this.emit("response.custom_tool_call_input.done", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          input,
        });
      } else {
        const argumentsText = asJson(parsedArguments);
        acc.item.arguments = argumentsText;
        this.emit("response.function_call_arguments.done", {
          item_id: acc.item.id,
          output_index: acc.outputIndex,
          arguments: argumentsText,
        });
      }
      this.emit("response.output_item.done", {
        output_index: acc.outputIndex,
        item: clone(acc.item),
      });
    } else if (acc.type === "google_search_call") {
      const args = finalStep?.arguments || acc.searchArguments || {};
      acc.raw.arguments = clone(args);
      acc.raw.id = finalStep?.id || acc.raw.id;
      acc.item.action = {
        type: "search",
        query: String(args.query || args.queries?.[0] || ""),
      };
      acc.item.status = "completed";
      this.emit("response.web_search_call.completed", {
        output_index: acc.outputIndex,
        item_id: acc.item.id,
      });
      this.emit("response.output_item.done", {
        output_index: acc.outputIndex,
        item: clone(acc.item),
      });
    }

    acc.stopped = true;
    if (generatedStep(acc.raw)) this.rawSteps.push(clone(acc.raw));
  }

  handle(event) {
    if (!event || this.finished) return;
    const type = event.event_type || event.type;
    if (type === "interaction.created") {
      this.interaction = event.interaction || this.interaction;
      this.start();
      return;
    }
    if (type === "step.start") {
      this.startStep(Number(event.index || 0), event.step || {});
      return;
    }
    if (type === "step.delta") {
      this.deltaStep(Number(event.index || 0), event.delta || {});
      return;
    }
    if (type === "step.stop") {
      this.stopStep(Number(event.index || 0), event.step || null);
      return;
    }
    if (type === "interaction.completed" || type === "interaction.failed") {
      const interaction = event.interaction || event;
      this.finish(interaction);
    }
  }

  ingestFinalSteps(steps = []) {
    for (let index = 0; index < steps.length; index += 1) {
      if (!this.steps.has(index)) this.startStep(index, steps[index]);
      this.stopStep(index, steps[index]);
    }
  }

  rebuildExactState(steps = []) {
    const exact = steps.filter(generatedStep).map(clone);
    if (exact.length) this.rawSteps = exact;
    for (const step of this.rawSteps) {
      if (step.type === "function_call" && step.id) {
        this.calls[step.id] = registryMetadata(this.registry, step.name);
      }
    }
  }

  finish(interaction = {}) {
    if (this.finished) return this.finalResponse;
    this.start();
    const finalSteps = Array.isArray(interaction.steps) ? interaction.steps : [];
    this.ingestFinalSteps(finalSteps);
    for (const [index, acc] of this.steps) {
      if (!acc.stopped) this.stopStep(index);
    }
    this.rebuildExactState(finalSteps);

    if (this.rawSteps.length > 0) {
      const stateItem = {
        id: id("rs"),
        type: "reasoning",
        summary: [],
        encrypted_content: this.stateEnvelope.seal(
          {
            version: 1,
            steps: this.rawSteps,
            coveredItemIds: this.coveredItemIds,
            calls: this.calls,
          },
          this.clientId
        ),
      };
      const outputIndex = this.addOutput(stateItem);
      this.emit("response.output_item.done", { output_index: outputIndex, item: clone(stateItem) });
    }

    const status = responseStatus(interaction.status);
    const usage = mapGeminiUsage(interaction.usage || {});
    const response = baseResponse({
      responseId: this.responseId,
      model: this.model,
      createdAt: this.createdAt,
      request: this.request,
      status,
    });
    response.output = clone(this.output);
    response.usage = usage;
    response.error = responseError(interaction);
    if (status === "incomplete") {
      response.incomplete_details = {
        reason: interaction.status === "budget_exceeded" ? "max_output_tokens" : "max_output_tokens",
      };
    }

    const terminalType =
      status === "completed"
        ? "response.completed"
        : status === "incomplete"
          ? "response.incomplete"
          : "response.failed";
    this.emit(terminalType, { response });
    this.finished = true;
    this.finalResponse = response;
    return response;
  }
}

export function translateGeminiInteraction(
  interaction,
  { model, registry, stateEnvelope, clientId, request = {}, responseId, now } = {}
) {
  const adapter = new ResponsesStreamAdapter({
    model,
    registry,
    stateEnvelope,
    clientId,
    request,
    responseId,
    now,
  });
  adapter.start();
  return adapter.finish(interaction);
}
