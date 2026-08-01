import fetch from "node-fetch";
import {
  classifyUpstreamFailure,
  isConfirmedInvalidKey,
  parseRetryAfter,
  runKeyPool,
} from "./keyPoolPolicy.js";

const DEFAULT_BASE_URL = "https://generativelanguage.googleapis.com";

function buildUrl(baseUrl, path, apiKey, query = {}) {
  const url = new URL(path, baseUrl);
  url.searchParams.set("key", apiKey);
  for (const [name, rawValue] of Object.entries(query || {})) {
    if (!name || name.toLowerCase() === "key" || rawValue === undefined || rawValue === null) continue;
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value !== "") url.searchParams.set(name, String(value));
  }
  return url.toString();
}

function attemptSignal(externalSignal, timeoutMs) {
  const controller = new AbortController();
  const abortExternal = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener("abort", abortExternal, { once: true });
  const timer = setTimeout(() => controller.abort(new Error("Gemini request timed out.")), timeoutMs);
  timer.unref?.();
  return {
    signal: controller.signal,
    cleanup() {
      clearTimeout(timer);
      externalSignal?.removeEventListener("abort", abortExternal);
    },
  };
}

function safeError(text, status) {
  let message = "";
  try {
    const parsed = JSON.parse(String(text || ""));
    message = parsed?.error?.message || parsed?.message || "";
  } catch {
    message = "";
  }
  return message
    ? message
        .replace(/AIza[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
        .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED]")
        .slice(0, 1000)
    : `Gemini returned HTTP ${status}.`;
}

async function fetchFailure(response, now = Date.now()) {
  const text = await response.text();
  return {
    decision: classifyUpstreamFailure(response.status, text),
    status: response.status,
    error: safeError(text, response.status),
    cooldownMs: parseRetryAfter(response.headers.get("retry-after"), now),
  };
}

export async function testSingleGeminiKey(
  key,
  {
    fetchImpl = fetch,
    baseUrl = process.env.GOOGLE_BASE_URL || DEFAULT_BASE_URL,
    timeoutMs = 10_000,
  } = {}
) {
  const start = Date.now();
  const signal = attemptSignal(null, timeoutMs);
  try {
    const response = await fetchImpl(buildUrl(baseUrl, "/v1beta/models", key, { pageSize: 1 }), {
      method: "GET",
      signal: signal.signal,
    });
    if (response.ok) return { ok: true, ms: Date.now() - start };
    const text = await response.text();
    return {
      ok: false,
      ms: Date.now() - start,
      error: isConfirmedInvalidKey(response.status, text)
        ? "کلید نامعتبر است."
        : safeError(text, response.status),
      status: response.status,
    };
  } catch {
    return { ok: false, ms: Date.now() - start, error: "Gemini network request failed." };
  } finally {
    signal.cleanup();
  }
}

export async function listGeminiModels({
  keyManager,
  fetchImpl = fetch,
  baseUrl = process.env.GOOGLE_BASE_URL || DEFAULT_BASE_URL,
  timeoutMs = Number(process.env.GOOGLE_FETCH_TIMEOUT_MS || 45_000),
  signal: externalSignal,
} = {}) {
  return runKeyPool({
    keyManager,
    attempt: async (keyObj) => {
      const signal = attemptSignal(externalSignal, timeoutMs);
      try {
        const response = await fetchImpl(
          buildUrl(baseUrl, "/v1beta/models", keyObj.key, { pageSize: 100 }),
          { method: "GET", signal: signal.signal }
        );
        if (!response.ok) return fetchFailure(response);
        return { decision: "success", status: response.status, data: await response.json() };
      } catch {
        return {
          decision: externalSignal?.aborted ? "return" : "retry",
          status: externalSignal?.aborted ? 499 : 0,
          error: externalSignal?.aborted ? "The client disconnected." : "Gemini network request failed.",
          aborted: Boolean(externalSignal?.aborted),
        };
      } finally {
        signal.cleanup();
      }
    },
  });
}

export async function callGeminiNonStream({
  keyManager,
  path,
  body,
  query = {},
  fetchImpl = fetch,
  baseUrl = process.env.GOOGLE_BASE_URL || DEFAULT_BASE_URL,
  timeoutMs = Number(process.env.GOOGLE_FETCH_TIMEOUT_MS || 45_000),
  signal: externalSignal,
} = {}) {
  return runKeyPool({
    keyManager,
    attempt: async (keyObj) => {
      const signal = attemptSignal(externalSignal, timeoutMs);
      try {
        const response = await fetchImpl(buildUrl(baseUrl, path, keyObj.key, query), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: signal.signal,
        });
        if (!response.ok) return fetchFailure(response);
        return { decision: "success", status: response.status, data: await response.json() };
      } catch {
        return {
          decision: externalSignal?.aborted ? "return" : "retry",
          status: externalSignal?.aborted ? 499 : 0,
          error: externalSignal?.aborted ? "The client disconnected." : "Gemini network request failed.",
          aborted: Boolean(externalSignal?.aborted),
        };
      } finally {
        signal.cleanup();
      }
    },
  });
}

function scanUsage(buffer, state) {
  let boundary;
  while ((boundary = buffer.value.search(/\r?\n\r?\n/)) !== -1) {
    const frame = buffer.value.slice(0, boundary);
    const separator = /^\r?\n\r?\n/.exec(buffer.value.slice(boundary))?.[0] || "\n\n";
    buffer.value = buffer.value.slice(boundary + separator.length);
    const data = frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const parsed = JSON.parse(data);
      if (parsed?.usageMetadata) state.value = parsed.usageMetadata;
    } catch {
      // Usage parsing must never interrupt the proxied stream.
    }
  }
}

export async function callGeminiStream({
  keyManager,
  path,
  body,
  query = {},
  onChunk,
  onStart,
  fetchImpl = fetch,
  baseUrl = process.env.GOOGLE_BASE_URL || DEFAULT_BASE_URL,
  connectTimeoutMs = Number(process.env.GOOGLE_STREAM_CONNECT_TIMEOUT_MS || 60_000),
  signal: externalSignal,
} = {}) {
  return runKeyPool({
    keyManager,
    attempt: async (keyObj) => {
      const signal = attemptSignal(externalSignal, connectTimeoutMs);
      let response;
      try {
        response = await fetchImpl(buildUrl(baseUrl, path, keyObj.key, { ...query, alt: "sse" }), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
          signal: signal.signal,
        });
      } catch {
        signal.cleanup();
        return {
          decision: externalSignal?.aborted ? "return" : "retry",
          status: externalSignal?.aborted ? 499 : 0,
          error: externalSignal?.aborted ? "The client disconnected." : "Gemini network request failed.",
          aborted: Boolean(externalSignal?.aborted),
        };
      }
      signal.cleanup();

      if (!response.ok) return fetchFailure(response);
      onStart?.(keyObj.index);
      const usage = { value: null };
      const buffer = { value: "" };
      try {
        for await (const chunk of response.body) {
          if (externalSignal?.aborted) throw new Error("Client disconnected.");
          onChunk?.(chunk);
          buffer.value += chunk.toString("utf8");
          scanUsage(buffer, usage);
        }
        return {
          decision: "success",
          status: response.status,
          streamStarted: true,
          data: { usageMetadata: usage.value },
        };
      } catch {
        return {
          decision: "return",
          status: externalSignal?.aborted ? 499 : 502,
          error: externalSignal?.aborted ? "The client disconnected." : "Gemini stream ended unexpectedly.",
          streamStarted: true,
          aborted: Boolean(externalSignal?.aborted),
        };
      }
    },
  });
}
