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

/** لیست مدل‌های موجود Gemini — GET /v1beta/models (برای پر کردن dropdown پنل تست) */
/** تست سریع یه کلید مشخص (بدون استفاده از keyManager rotation) — سبک، بدون هزینه‌ی generation */
export async function testSingleGeminiKey(key) {
  const start = Date.now();
  const url = buildUrl("/v1beta/models", key, { pageSize: 1 });
  try {
    const resp = await fetch(url, {
      method: "GET",
      signal: makeTimeoutSignal(10000),
    });
    const ms = Date.now() - start;
    if (resp.ok) {
      return { ok: true, ms };
    }
    const errText = await resp.text();
    if (isInvalidApiKeyError(resp.status, errText)) {
      return { ok: false, ms, error: "کلید نامعتبر است.", status: resp.status };
    }
    return { ok: false, ms, error: errText.slice(0, 200), status: resp.status };
  } catch (err) {
    return { ok: false, ms: Date.now() - start, error: err.message };
  }
}

export async function listGeminiModels({ keyManager }) {
  const orderedKeys = keyManager.getAvailableOrder();
  let lastError = null;

  for (const keyObj of orderedKeys) {
    const url = buildUrl("/v1beta/models", keyObj.key, { pageSize: 100 });
    try {
      const resp = await fetch(url, {
        method: "GET",
        signal: makeTimeoutSignal(FETCH_TIMEOUT_MS),
      });
      if (resp.ok) {
        const data = await resp.json();
        keyManager.markSuccess(keyObj);
        return { ok: true, status: resp.status, data };
      }
      const errText = await resp.text();
      lastError = { status: resp.status, body: errText };
      if (isInvalidApiKeyError(resp.status, errText)) {
        keyManager.markInvalid(keyObj);
        continue;
      }
      keyManager.markRateLimited(keyObj);
      continue;
    } catch (networkErr) {
      lastError = { status: 0, body: networkErr.message };
      keyManager.markRateLimited(keyObj);
      continue;
    }
  }

  return {
    ok: false,
    status: lastError?.status || 502,
    error: lastError?.body || "لیست مدل‌ها قابل دریافت نبود.",
  };
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

      let sseBuffer = "";
      let lastUsageMetadata = null;

      for await (const chunk of resp.body) {
        onChunk(chunk);

        // موازی با پاس دادن chunk خام به کلاینت، دنبال آخرین usageMetadata تو استریم SSE می‌گردیم
        // (Gemini معمولاً usageMetadata رو تو آخرین رویداد data: {...} استریم می‌فرسته)
        try {
          sseBuffer += chunk.toString("utf8");
          const lines = sseBuffer.split("\n");
          sseBuffer = lines.pop() ?? ""; // خط ناقص آخر رو نگه دار برای chunk بعدی
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonPart = trimmed.slice(5).trim();
            if (!jsonPart || jsonPart === "[DONE]") continue;
            try {
              const parsed = JSON.parse(jsonPart);
              if (parsed?.usageMetadata) lastUsageMetadata = parsed.usageMetadata;
            } catch {
              // خط ناقص یا غیر JSON — نادیده بگیر
            }
          }
        } catch {
          // parse کردن usageMetadata فقط برای آمار مصرفه؛ اگه fail بشه نباید جلوی استریم اصلی رو بگیره
        }
      }

      return { ok: true, usedKeyIndex: keyObj.index, data: { usageMetadata: lastUsageMetadata } };
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
