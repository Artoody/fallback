// geminiClient.js
// فراخوانی Gemini مثل کلاینت رسمی:
// POST /v1beta/models/{model}:{method}
// Auth: ?key= (روش قبلی کارکننده)
// Body: همان JSON کلاینت

import fetch from "node-fetch";

const GOOGLE_BASE_URL = process.env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com";
// فقط برای شروع اتصال / پاسخ غیر استریم
const FETCH_TIMEOUT_MS = parseInt(process.env.GOOGLE_FETCH_TIMEOUT_MS || "45000", 10);
// استریم thinking ممکن است خیلی طول بکشد — تایم‌اوت کلّی نباید وسطش قطع کند
const STREAM_CONNECT_TIMEOUT_MS = parseInt(process.env.GOOGLE_STREAM_CONNECT_TIMEOUT_MS || "60000", 10);

const RETRYABLE_STATUS_CODES = new Set([429, 500, 503]);

function isRetryableStatus(status) {
  return RETRYABLE_STATUS_CODES.has(status);
}

function isInvalidApiKeyError(status, errText = "") {
  // فقط پیام JSON گوگل — نه هر 401/403 (مثلاً HTML fortigate/CDN)
  const text = String(errText);
  return (
    /API_KEY_INVALID/i.test(text) ||
    /API key not valid/i.test(text) ||
    /API_KEY_SERVICE_BLOCKED/i.test(text) ||
    /API key expired/i.test(text)
  );
}

function isClientRequestError(status, errText = "") {
  if (status !== 400) return false;
  if (isInvalidApiKeyError(status, errText)) return false;
  return true;
}

function buildUrl(path, apiKey, query = {}) {
  const url = new URL(GOOGLE_BASE_URL + path);
  url.searchParams.set("key", apiKey);
  for (const [k, v] of Object.entries(query || {})) {
    if (!k || k.toLowerCase() === "key") continue;
    if (v === undefined || v === null || v === "") continue;
    const value = Array.isArray(v) ? v[0] : v;
    url.searchParams.set(k, String(value));
  }
  return url.toString();
}

function buildGoogleHeaders() {
  return {
    "Content-Type": "application/json",
  };
}

function makeTimeoutSignal(ms) {
  if (typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function") {
    return AbortSignal.timeout(ms);
  }
  const ctrl = new AbortController();
  setTimeout(() => ctrl.abort(), ms);
  return ctrl.signal;
}

export async function callGeminiNonStream({ keyManager, path, body, query = {} }) {
  const orderedKeys = keyManager.getAvailableOrder();
  let lastError = null;

  for (const keyObj of orderedKeys) {
    const url = buildUrl(path, keyObj.key, query);
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: buildGoogleHeaders(),
        body: JSON.stringify(body ?? {}),
        signal: makeTimeoutSignal(FETCH_TIMEOUT_MS),
      });

      if (resp.ok) {
        const data = await resp.json();
        keyManager.markSuccess(keyObj);
        return { ok: true, status: resp.status, data, usedKeyIndex: keyObj.index };
      }

      const errText = await resp.text();
      lastError = { status: resp.status, body: errText, usedKeyIndex: keyObj.index };

      if (isInvalidApiKeyError(resp.status, errText)) {
        keyManager.markInvalid(keyObj);
        continue;
      }

      if (isRetryableStatus(resp.status)) {
        keyManager.markRateLimited(keyObj);
        continue;
      }

      if (isClientRequestError(resp.status, errText)) {
        return { ok: false, status: resp.status, error: errText, usedKeyIndex: keyObj.index };
      }

      keyManager.markRateLimited(keyObj);
      continue;
    } catch (networkErr) {
      lastError = { status: 0, body: networkErr.message, usedKeyIndex: keyObj.index };
      keyManager.markRateLimited(keyObj);
      continue;
    }
  }

  return {
    ok: false,
    status: lastError?.status || 429,
    error: lastError?.body || "تمام کلیدهای API با خطا مواجه شدند یا rate-limit خوردند.",
    allKeysExhausted: true,
  };
}

/**
 * onStart فقط وقتی استریم گوگل واقعاً شروع شد صدا زده می‌شود.
 * بعد از شروع استریم دیگر سراغ کلید بعدی نمی‌رویم (وگرنه JSON ناقص به Cline می‌رسد).
 */
export async function callGeminiStream({ keyManager, path, body, query = {}, onChunk, onStart }) {
  const orderedKeys = keyManager.getAvailableOrder();
  let lastError = null;
  let sawRateLimit = false;

  const streamQuery = { ...query, alt: "sse" };

  for (const keyObj of orderedKeys) {
    const url = buildUrl(path, keyObj.key, streamQuery);
    let streamStarted = false;
    const connectCtrl = new AbortController();
    const connectTimer = setTimeout(() => connectCtrl.abort(), STREAM_CONNECT_TIMEOUT_MS);

    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: buildGoogleHeaders(),
        body: JSON.stringify(body ?? {}),
        signal: connectCtrl.signal,
      });

      clearTimeout(connectTimer);

      if (!resp.ok) {
        const errText = await resp.text();
        lastError = { status: resp.status, body: errText, usedKeyIndex: keyObj.index };

        if (resp.status === 429) sawRateLimit = true;

        if (isInvalidApiKeyError(resp.status, errText)) {
          keyManager.markInvalid(keyObj);
          continue;
        }

        if (isRetryableStatus(resp.status)) {
          keyManager.markRateLimited(keyObj);
          continue;
        }

        if (isClientRequestError(resp.status, errText)) {
          return { ok: false, status: resp.status, error: errText, usedKeyIndex: keyObj.index };
        }

        keyManager.markRateLimited(keyObj);
        continue;
      }

      streamStarted = true;
      if (onStart) onStart(keyObj.index);
      keyManager.markSuccess(keyObj);

      for await (const chunk of resp.body) {
        onChunk(chunk);
      }

      return { ok: true, usedKeyIndex: keyObj.index };
    } catch (networkErr) {
      clearTimeout(connectTimer);
      lastError = { status: 0, body: networkErr.message, usedKeyIndex: keyObj.index };

      if (streamStarted) {
        return {
          ok: false,
          status: 502,
          error: lastError.body,
          usedKeyIndex: keyObj.index,
          streamStarted: true,
        };
      }

      keyManager.markRateLimited(keyObj);
      continue;
    } finally {
      clearTimeout(connectTimer);
    }
  }

  // اگر بیشتر quota بوده تا invalid، همان را به کلاینت بگو (Cline گیج نشود)
  if (sawRateLimit && lastError?.status === 400 && /API_KEY_INVALID/i.test(String(lastError.body || ""))) {
    return {
      ok: false,
      status: 429,
      error: "تمام کلیدها یا rate-limit خورده‌اند یا نامعتبرند. بعداً دوباره تلاش کنید.",
      allKeysExhausted: true,
    };
  }

  return {
    ok: false,
    status: lastError?.status || 429,
    error: lastError?.body || "تمام کلیدهای API با خطا مواجه شدند یا rate-limit خوردند.",
    allKeysExhausted: true,
  };
}
