export const RETRYABLE_UPSTREAM_STATUSES = new Set([429, 500, 502, 503, 504]);

export function isConfirmedInvalidKey(status, body = "") {
  if (![400, 401, 403].includes(Number(status))) return false;
  const text = String(body || "");
  return (
    /API_KEY_INVALID/i.test(text) ||
    /API key not valid/i.test(text) ||
    /API_KEY_SERVICE_BLOCKED/i.test(text) ||
    /API key expired/i.test(text)
  );
}

export function classifyUpstreamFailure(status, body = "") {
  if (isConfirmedInvalidKey(status, body)) return "invalid";
  if (RETRYABLE_UPSTREAM_STATUSES.has(Number(status))) return "retry";
  return "return";
}

export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : 0;
}

export async function runKeyPool({ keyManager, attempt }) {
  const readyKeys = keyManager.getAvailableOrder();
  if (readyKeys.length === 0) {
    const retryAfterMs = keyManager.retryAfterMs();
    return {
      ok: false,
      status: 429,
      error: "No Gemini API key is currently ready.",
      allKeysExhausted: true,
      retryAfterMs,
    };
  }

  let lastResult = null;
  for (const keyObj of readyKeys) {
    if (keyObj.blockedUntil > keyManager.now()) continue;
    let result;
    try {
      result = await attempt(keyObj);
    } catch (error) {
      result = {
        decision: "retry",
        ok: false,
        status: 0,
        error: error?.message || "Upstream network failure.",
      };
    }
    lastResult = { ...result, usedKeyIndex: keyObj.index };

    if (result.decision === "success" || result.ok === true) {
      keyManager.markSuccess(keyObj);
      return { ...result, ok: true, usedKeyIndex: keyObj.index };
    }
    if (result.streamStarted && !result.aborted) {
      keyManager.markRateLimited(keyObj, result.cooldownMs || undefined);
      return { ...result, ok: false, usedKeyIndex: keyObj.index };
    }
    if (result.decision === "return" || result.aborted) {
      return { ...result, ok: false, usedKeyIndex: keyObj.index };
    }
    if (result.decision === "invalid") {
      keyManager.markInvalid(keyObj);
      continue;
    }

    keyManager.markRateLimited(keyObj, result.cooldownMs || undefined);
  }

  const retryAfterMs = keyManager.retryAfterMs();
  return {
    ok: false,
    status: 429,
    error: "All ready Gemini API keys were exhausted by retryable upstream failures.",
    allKeysExhausted: true,
    retryAfterMs,
    lastStatus: lastResult?.status || null,
    usedKeyIndex: lastResult?.usedKeyIndex,
  };
}
