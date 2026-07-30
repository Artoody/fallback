import fetch from "node-fetch";
import {
  classifyUpstreamFailure,
  parseRetryAfter,
  runKeyPool,
} from "./keyPoolPolicy.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";
const DEFAULT_PATH = "/v1beta/interactions";

function redactUpstreamMessage(text, status) {
  let message = "";
  try {
    const parsed = JSON.parse(String(text || ""));
    message = parsed?.error?.message || parsed?.message || "";
  } catch {
    message = String(text || "");
  }
  return (
    message
      .replace(/AIza[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
      .replace(/gemini-state\.v\d+\.[A-Za-z0-9_-]+/g, "[REDACTED_STATE]")
      .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED]")
      .slice(0, 1000) || `Gemini returned HTTP ${status}.`
  );
}

function combinedAttemptSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  let timedOut = false;
  const abortExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener("abort", abortExternal, { once: true });
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error("Gemini connection timed out."));
  }, timeoutMs);
  if (typeof timer.unref === "function") timer.unref();
  return {
    signal: controller.signal,
    controller,
    timedOut: () => timedOut,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
  };
}

async function* chunks(body) {
  if (body && typeof body[Symbol.asyncIterator] === "function") {
    yield* body;
    return;
  }
  if (body?.getReader) {
    const reader = body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock?.();
    }
    return;
  }
  throw new Error("Gemini returned a response without a readable body.");
}

export async function* parseSse(body, { signal, onActivity } = {}) {
  const decoder = new TextDecoder();
  let buffer = "";

  function parseFrame(frame) {
    const dataLines = [];
    for (const line of frame.split(/\r?\n/)) {
      if (line.startsWith(":")) continue;
      if (line.startsWith("data:")) dataLines.push(line.slice(5).replace(/^ /, ""));
    }
    return dataLines.join("\n");
  }

  for await (const chunk of chunks(body)) {
    if (signal?.aborted) throw signal.reason || new Error("Request aborted.");
    onActivity?.();
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const frame = buffer.slice(0, boundary);
      const separator = /^\r?\n\r?\n/.exec(buffer.slice(boundary))?.[0] || "\n\n";
      buffer = buffer.slice(boundary + separator.length);
      const data = parseFrame(frame);
      if (!data) continue;
      if (data === "[DONE]") {
        yield { event_type: "done" };
        continue;
      }
      try {
        yield JSON.parse(data);
      } catch {
        throw new Error("Gemini returned malformed SSE data.");
      }
    }
  }

  buffer += decoder.decode();
  const trailing = parseFrame(buffer.trim());
  if (trailing && trailing !== "[DONE]") {
    try {
      yield JSON.parse(trailing);
    } catch {
      throw new Error("Gemini returned malformed trailing SSE data.");
    }
  }
}

export function createGeminiInteractionsClient({
  keyManager,
  fetchImpl = fetch,
  baseUrl = process.env.GOOGLE_BASE_URL || DEFAULT_BASE_URL,
  path = process.env.GEMINI_INTERACTIONS_PATH || DEFAULT_PATH,
  connectTimeoutMs = Number(process.env.GOOGLE_FETCH_TIMEOUT_MS || 45_000),
  streamIdleTimeoutMs = Number(process.env.GOOGLE_STREAM_IDLE_TIMEOUT_MS || 300_000),
  now = () => Date.now(),
} = {}) {
  if (!keyManager) throw new Error("keyManager is required.");

  async function create({ request, stream = false, signal, onStart, onEvent } = {}) {
    return runKeyPool({
      keyManager,
      attempt: async (keyObj) => {
        const attemptSignal = combinedAttemptSignal(signal, connectTimeoutMs);
        let response;
        try {
          response = await fetchImpl(new URL(path, baseUrl).toString(), {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "x-goog-api-key": keyObj.key,
            },
            body: JSON.stringify({ ...request, stream }),
            signal: attemptSignal.signal,
          });
        } catch (error) {
          const aborted = Boolean(signal?.aborted);
          return {
            decision: aborted ? "return" : "retry",
            status: aborted ? 499 : 0,
            error: aborted
              ? "The client disconnected."
              : attemptSignal.timedOut()
                ? "Gemini connection timed out."
                : "Gemini network request failed.",
            aborted,
          };
        } finally {
          attemptSignal.cleanup();
        }

        if (!response.ok) {
          const text = await response.text();
          const decision = classifyUpstreamFailure(response.status, text);
          return {
            decision,
            status: response.status,
            error: redactUpstreamMessage(text, response.status),
            cooldownMs: parseRetryAfter(response.headers.get("retry-after"), now()),
          };
        }

        if (!stream) {
          let interaction;
          try {
            interaction = await response.json();
          } catch {
            return {
              decision: "retry",
              status: 502,
              error: "Gemini returned invalid JSON.",
            };
          }
          return { decision: "success", status: response.status, data: interaction };
        }

        onStart?.(keyObj.index);
        let idleTimer;
        const streamController = new AbortController();
        const abortStream = (reason) => {
          if (!streamController.signal.aborted) streamController.abort(reason);
          response.body?.destroy?.(reason instanceof Error ? reason : undefined);
        };
        const abortExternal = () => abortStream(signal?.reason);
        if (signal?.aborted) abortExternal();
        else signal?.addEventListener("abort", abortExternal, { once: true });
        const armIdleTimer = () => {
          clearTimeout(idleTimer);
          idleTimer = setTimeout(
            () => abortStream(new Error("Gemini stream became idle.")),
            streamIdleTimeoutMs
          );
          if (typeof idleTimer.unref === "function") idleTimer.unref();
        };
        armIdleTimer();

        let interaction = null;
        try {
          for await (const event of parseSse(response.body, {
            signal: streamController.signal,
            onActivity: armIdleTimer,
          })) {
            if (event.event_type === "interaction.completed" || event.event_type === "interaction.failed") {
              interaction = event.interaction || event;
            }
            if (event.event_type !== "done") onEvent?.(event);
          }
          return {
            decision: "success",
            status: response.status,
            data: interaction,
            streamStarted: true,
          };
        } catch {
          return {
            decision: "return",
            status: signal?.aborted ? 499 : 502,
            error: signal?.aborted ? "The client disconnected." : "Gemini stream ended unexpectedly.",
            streamStarted: true,
            aborted: Boolean(signal?.aborted),
          };
        } finally {
          clearTimeout(idleTimer);
          signal?.removeEventListener("abort", abortExternal);
          if (!streamController.signal.aborted) streamController.abort();
        }
      },
    });
  }

  return Object.freeze({ create });
}
