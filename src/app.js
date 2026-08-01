// app.js
// پروکسی Gemini با fallback بین چند کلید + پنل ادمین برای دانش‌آموزان

import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import KeyManager from "./keyManager.js";
import Store from "./store.js";
import { callGeminiNonStream, callGeminiStream, listGeminiModels, testSingleGeminiKey } from "./geminiClient.js";
import { createGeminiInteractionsClient } from "./geminiInteractionsClient.js";
import { createStateEnvelope } from "./codex/stateEnvelope.js";
import { createResponsesRouter } from "./routes/responses.js";
import {
  classifyUpstreamFailure,
  parseRetryAfter,
  runKeyPool,
} from "./keyPoolPolicy.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createApp({
  env = process.env,
  storage,
  keyManager: injectedKeyManager,
  fetchImpl = globalThis.fetch,
  logger = console,
  now = () => Date.now(),
} = {}) {
const app = express();
app.use(express.json({ limit: "50mb" }));

const ADMIN_PASSWORD = env.ADMIN_PASSWORD || "";
const PROXY_API_KEY = env.PROXY_API_KEY;

const envGeminiKeys = (env.GEMINI_API_KEYS || "")
  .split(/[,\n\r]+/)
  .map((k) => k.trim().replace(/^["']+|["']+$/g, "").trim())
  .filter(Boolean);

const configuredSecrets = [
  ...envGeminiKeys,
  env.PROXY_API_KEY,
  env.RESPONSES_STATE_SECRET,
  env.ADMIN_PASSWORD,
].filter((value) => typeof value === "string" && value.length >= 8);

function redactSensitive(value) {
  let text = String(value ?? "");
  for (const secret of configuredSecrets) text = text.split(secret).join("[REDACTED]");
  return text
    .replace(/AIza[A-Za-z0-9_-]{20,}/g, "[REDACTED]")
    .replace(/gemini-state\.v\d+\.[A-Za-z0-9_-]+/g, "[REDACTED_STATE]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED]");
}

function sanitizeLogValue(value) {
  if (typeof value === "string") return redactSensitive(value);
  if (Array.isArray(value)) return value.map(sanitizeLogValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !/^(key|credential|encrypted_content|signature)$/i.test(key))
        .map(([key, nested]) => [key, sanitizeLogValue(nested)])
    );
  }
  return value;
}

const store = storage || new Store({ dataDir: env.DATA_DIR });
store.seedFromEnv({ geminiKeys: envGeminiKeys, proxyApiKey: PROXY_API_KEY });

// اگر در env کلید Gemini باشد، همان منبع حقیقت است
if (envGeminiKeys.length > 0) {
  store.setGeminiKeys(envGeminiKeys);
}

const geminiKeys = store.getGeminiKeys();
if (!geminiKeys.length) {
  throw new Error("هیچ کلید Geminiای تعریف نشده. GEMINI_API_KEYS یا پنل ادمین را چک کن.");
}

const keyManager =
  injectedKeyManager ||
  new KeyManager(geminiKeys, {
    cooldownMs: Number(env.KEY_COOLDOWN_MS || 60_000),
    invalidKeyCooldownMs: Number(env.INVALID_KEY_COOLDOWN_MS || 24 * 60 * 60 * 1000),
    now,
  });
logger.log(`[gemini-fallback-proxy] ${geminiKeys.length} کلید Gemini بارگذاری شد.`);
logger.log(`[gemini-fallback-proxy] ${store.listClients().length} کلید دانش‌آموز فعال است.`);

let stateEnvelope = null;
if (env.RESPONSES_STATE_SECRET) {
  stateEnvelope = createStateEnvelope({ secret: env.RESPONSES_STATE_SECRET });
} else {
  logger.warn(
    "[gemini-fallback-proxy] RESPONSES_STATE_SECRET تنظیم نشده؛ /v1/responses غیرفعال است."
  );
}

const interactionsClient = createGeminiInteractionsClient({
  keyManager,
  fetchImpl,
  baseUrl: env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com",
  path: env.GEMINI_INTERACTIONS_PATH || "/v1beta/interactions",
  connectTimeoutMs: Number(env.GOOGLE_FETCH_TIMEOUT_MS || 45_000),
  streamIdleTimeoutMs: Number(env.GOOGLE_STREAM_IDLE_TIMEOUT_MS || 300_000),
  now,
});

if (!ADMIN_PASSWORD) {
  logger.warn(
    "[gemini-fallback-proxy] هشدار: ADMIN_PASSWORD تنظیم نشده. پنل /admin قفل می‌ماند تا مقدار بگذاری."
  );
}

// ----------------------------------------------------------------
// Auth: فقط credential فعال و ذخیره‌شده معتبر است.
// ----------------------------------------------------------------
function extractProvidedKey(req) {
  const googHeaderKey = req.get("x-goog-api-key");
  const customHeaderKey = req.get("x-api-key");
  const authHeader = req.get("authorization");
  const bearerKey = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : null;
  const queryKey = req.query.key;
  return googHeaderKey || customHeaderKey || bearerKey || queryKey || null;
}

function requireClientAuth(req, res, next) {
  const providedKey = extractProvidedKey(req);
  if (!providedKey) {
    return res.status(401).json({ error: { message: "دسترسی غیرمجاز. کلید API معتبر ارسال نشده." } });
  }

  const client = store.findClientByKey(providedKey);

  if (!client) {
    return res.status(401).json({ error: { message: "دسترسی غیرمجاز. کلید API معتبر ارسال نشده." } });
  }

  req.client = client;
  next();
}

// مقایسه‌ی امن برای جلوگیری از timing attack روی رمز ادمین
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ----------------------------------------------------------------
// Rate limit برای /admin/api/login
// ----------------------------------------------------------------
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map();

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const timestamp = now();
  let entry = loginAttempts.get(ip);

  if (!entry || entry.resetAt <= timestamp) {
    entry = { count: 0, resetAt: timestamp + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const waitSec = Math.ceil((entry.resetAt - timestamp) / 1000);
    return res.status(429).json({
      error: `تعداد تلاش‌های ورود بیش از حد مجاز است. ${waitSec} ثانیه دیگر دوباره امتحان کن.`,
    });
  }

  entry.count += 1;
  req._loginEntry = entry;
  next();
}

const loginCleanupTimer = setInterval(() => {
  const timestamp = now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (entry.resetAt <= timestamp) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000).unref?.();

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD روی سرور تنظیم نشده." });
  }
  const header = req.get("x-admin-password") || "";
  const authHeader = req.get("authorization");
  const bearer = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const provided = header || bearer;
  if (!provided || !safeEqual(provided, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "رمز ادمین نامعتبر است." });
  }
  next();
}

// ----------------------------------------------------------------
// لاگ خطاهای اخیر + Live Activity (SSE)
// ----------------------------------------------------------------
const MAX_ERROR_LOG = 100;
const errorLog = [];
const MAX_LIVE_LOG = 200;
const liveLog = [];
const liveClients = new Set(); // res objects subscribed to /admin/api/live

function logError({ type, message, clientName, model, status, keyIndex }) {
  errorLog.unshift({
    time: new Date().toISOString(),
    type: type || "unknown",
    message: redactSensitive(message).slice(0, 500),
    clientName: redactSensitive(clientName || "") || null,
    model: model || null,
    status: status || null,
    keyIndex: keyIndex ?? null,
  });
  if (errorLog.length > MAX_ERROR_LOG) errorLog.length = MAX_ERROR_LOG;
}

/** رویداد زنده برای پنل ادمین — نوع‌ها: request | try | success | fail | cooldown | exhausted | info */
function emitLive(event) {
  const entry = {
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    ...sanitizeLogValue(event),
  };
  liveLog.unshift(entry);
  if (liveLog.length > MAX_LIVE_LOG) liveLog.length = MAX_LIVE_LOG;

  const payload = `data: ${JSON.stringify(entry)}\n\n`;
  for (const client of liveClients) {
    try {
      client.write(payload);
      if (typeof client.flush === "function") client.flush();
    } catch {
      liveClients.delete(client);
    }
  }
  return entry;
}

function trackResult(req, result, extra = {}) {
  if (!result?.ok) {
    logError({
      type: extra.type || "gemini_call",
      message: result?.error,
      clientName: req.client?.name,
      model: extra.model,
      status: result?.status,
      keyIndex: result?.usedKeyIndex,
    });
  }
  if (!req.client || !req.client.id || req.client.id === "env-proxy") return;
  const usageMetadata = result?.ok ? result?.data?.usageMetadata : null;
  store.recordUsage(req.client.id, { ok: Boolean(result?.ok), usageMetadata });
}

app.use(
  "/v1",
  createResponsesRouter({
    requireClientAuth,
    interactionsClient,
    stateEnvelope,
    trackUsage: trackResult,
    emitLive,
  })
);

// ----------------------------------------------------------------
// Health + Admin UI
// ----------------------------------------------------------------
app.get("/", (req, res) => {
  res.json({
    status: "ok",
    message: "Gemini fallback proxy در حال اجراست.",
    admin: "/admin/",
    geminiKeys: store.getGeminiKeys().length,
    clients: store.listClients().length,
  });
});

app.use("/admin", express.static(path.join(__dirname, "..", "web", "admin")));

// ----------------------------------------------------------------
// Admin API
// ----------------------------------------------------------------
app.post("/admin/api/login", loginRateLimiter, (req, res) => {
  const password = req.body?.password;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD روی سرور تنظیم نشده." });
  }
  if (!password || !safeEqual(password, ADMIN_PASSWORD)) {
    return res.status(401).json({ error: "رمز اشتباه است." });
  }
  if (req._loginEntry) req._loginEntry.count = 0;
  return res.json({ ok: true });
});

app.get("/admin/api/overview", requireAdmin, (req, res) => {
  const clients = store.listClients();
  const totalRequests = clients.reduce((s, c) => s + (c.stats?.requests || 0), 0);
  res.json({
    geminiKeyCount: store.getGeminiKeys().length,
    clientCount: clients.length,
    totalRequests,
    geminiStatus: keyManager.status(),
  });
});

app.get("/admin/api/gemini-keys", requireAdmin, (req, res) => {
  res.json({ keys: store.listGeminiKeysMasked(), status: keyManager.status() });
});

app.post("/admin/api/gemini-keys", requireAdmin, (req, res) => {
  try {
    const key = req.body?.key;
    store.addGeminiKey(key);
    keyManager.addKey(key);
    res.json({ ok: true, keys: store.listGeminiKeysMasked() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/admin/api/gemini-keys/bulk", requireAdmin, (req, res) => {
  try {
    const raw = req.body?.text || "";
    const candidates = String(raw)
      .split(/[,\n\r]+/)
      .map((k) => k.trim().replace(/^["']+|["']+$/g, "").trim())
      .filter(Boolean);

    if (!candidates.length) {
      return res.status(400).json({ error: "هیچ کلید معتبری پیدا نشد." });
    }

    const existing = new Set(store.getGeminiKeys());
    const added = [];
    const skipped = [];

    for (const k of candidates) {
      if (existing.has(k) || added.includes(k)) {
        skipped.push(k.slice(0, 8) + "…");
        continue;
      }
      store.addGeminiKey(k);
      keyManager.addKey(k);
      added.push(k);
    }

    res.json({
      ok: true,
      addedCount: added.length,
      skippedCount: skipped.length,
      keys: store.listGeminiKeysMasked(),
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/admin/api/gemini-keys/:index", requireAdmin, (req, res) => {
  try {
    const index = Number(req.params.index);
    if (store.getGeminiKeys().length <= 1) {
      return res.status(400).json({ error: "حداقل یک کلید Gemini باید باقی بماند." });
    }
    store.removeGeminiKey(index);
    keyManager.syncKeys(store.getGeminiKeys());
    res.json({ ok: true, keys: store.listGeminiKeysMasked() });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/admin/api/gemini-keys/:index/test", requireAdmin, async (req, res) => {
  try {
    const index = Number(req.params.index);
    const keys = store.getGeminiKeys();
    if (index < 0 || index >= keys.length) {
      return res.status(400).json({ error: "ایندکس نامعتبر است." });
    }
    const result = await testSingleGeminiKey(keys[index], {
      fetchImpl,
      baseUrl: env.GOOGLE_BASE_URL,
    });
    if (!result.ok) {
      logError({
        type: "key_test",
        message: result.error,
        clientName: "ادمین (تست کلید)",
        status: result.status,
        keyIndex: index,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/admin/api/clients", requireAdmin, (req, res) => {
  res.json({ clients: store.listClients() });
});

app.post("/admin/api/clients", requireAdmin, (req, res) => {
  try {
    const { name, key } = req.body || {};
    const client = store.createClient(name, { key });
    res.json({ ok: true, client });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch("/admin/api/clients/:id", requireAdmin, (req, res) => {
  try {
    const client = store.updateClient(req.params.id, req.body || {});
    res.json({ ok: true, client });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/admin/api/clients/:id/regenerate", requireAdmin, (req, res) => {
  try {
    const client = store.regenerateClientKey(req.params.id);
    res.json({ ok: true, client });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete("/admin/api/clients/:id", requireAdmin, (req, res) => {
  try {
    store.deleteClient(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/admin/api/gemini-status", requireAdmin, (req, res) => {
  res.json(keyManager.status());
});

app.get("/admin/api/errors", requireAdmin, (req, res) => {
  res.json({ errors: errorLog });
});

app.delete("/admin/api/errors", requireAdmin, (req, res) => {
  errorLog.length = 0;
  res.json({ ok: true });
});

// تاریخچهٔ زنده (برای رفرش اولیه قبل از وصل شدن به SSE)
app.get("/admin/api/live-history", requireAdmin, (req, res) => {
  res.json({ events: liveLog.slice(0, 80) });
});

// SSE — لاگ زنده فعالیت کلیدها
app.get("/admin/api/live", requireAdmin, (req, res) => {
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  if (typeof res.flushHeaders === "function") res.flushHeaders();

  res.write(`data: ${JSON.stringify({ type: "connected", message: "متصل به لاگ زنده", time: new Date().toISOString() })}\n\n`);

  liveClients.add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(`: ping ${Date.now()}\n\n`);
    } catch {
      clearInterval(heartbeat);
      liveClients.delete(res);
    }
  }, 25000);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  req.on("close", () => {
    clearInterval(heartbeat);
    liveClients.delete(res);
  });
});

app.get("/admin/api/models", requireAdmin, async (req, res) => {
  const result = await listGeminiModels({
    keyManager,
    fetchImpl,
    baseUrl: env.GOOGLE_BASE_URL,
  });
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json({ models: result.data?.models || [] });
});

app.post("/admin/api/test-prompt", requireAdmin, async (req, res) => {
  try {
    const { model, prompt } = req.body || {};
    if (!model || !prompt) {
      return res.status(400).json({ error: "model و prompt هر دو الزامی‌اند." });
    }
    const result = await callGeminiNonStream({
      keyManager,
      path: `/v1beta/models/${model}:generateContent`,
      body: { contents: [{ role: "user", parts: [{ text: prompt }] }] },
      fetchImpl,
      baseUrl: env.GOOGLE_BASE_URL,
    });

    if (!result.ok) {
      logError({
        type: "test_prompt",
        message: result.error,
        clientName: "ادمین (پنل تست)",
        model,
        status: result.status,
        keyIndex: result.usedKeyIndex,
      });
      return res.status(result.status || 502).json({
        error: result.error,
        allKeysExhausted: result.allKeysExhausted || false,
      });
    }

    const text =
      result.data?.candidates?.[0]?.content?.parts?.map((p) => p.text).join("") || "";

    res.json({
      ok: true,
      text,
      usedKeyIndex: result.usedKeyIndex,
      usageMetadata: result.data?.usageMetadata || null,
      raw: result.data,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------------------
// OpenAI Chat Completions compatibility, using the same shared pool policy.
// ----------------------------------------------------------------
app.post("/v1/chat/completions", requireClientAuth, async (req, res) => {
  const isStreaming = req.body?.stream === true;
  const model = req.body?.model || "?";
  const clientName = req.client?.name || "unknown";
  const controller = new AbortController();
  const abortUpstream = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);

  emitLive({
    type: "request",
    message: `Chat Completions${isStreaming ? " (stream)" : ""}`,
    clientName,
    model,
    detail: isStreaming ? "stream" : "normal",
  });

  try {
    const result = await runKeyPool({
      keyManager,
      attempt: async (keyObj) => {
        emitLive({
          type: "try",
          message: `آزمایش کلید #${keyObj.index + 1}`,
          clientName,
          model,
          keyIndex: keyObj.index,
        });

        let response;
        try {
          response = await fetchImpl(
            new URL(
              "/v1beta/openai/chat/completions",
              env.GOOGLE_BASE_URL || "https://generativelanguage.googleapis.com"
            ),
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${keyObj.key}`,
              },
              body: JSON.stringify(req.body),
              signal: controller.signal,
            }
          );
        } catch {
          return {
            decision: controller.signal.aborted ? "return" : "retry",
            status: controller.signal.aborted ? 499 : 0,
            error: controller.signal.aborted ? "The client disconnected." : "Gemini network request failed.",
            aborted: controller.signal.aborted,
          };
        }

        if (!response.ok) {
          const raw = await response.text();
          let data;
          try {
            data = JSON.parse(raw);
          } catch {
            data = { error: { message: `Gemini returned HTTP ${response.status}.` } };
          }
          return {
            decision: classifyUpstreamFailure(response.status, raw),
            status: response.status,
            error: `Gemini returned HTTP ${response.status}.`,
            data,
            cooldownMs: parseRetryAfter(response.headers.get("retry-after"), now()),
          };
        }

        if (!isStreaming) {
          try {
            return { decision: "success", status: response.status, data: await response.json() };
          } catch {
            return { decision: "retry", status: 502, error: "Gemini returned invalid JSON." };
          }
        }

        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        try {
          for await (const chunk of response.body) {
            if (controller.signal.aborted) throw new Error("Client disconnected.");
            res.write(chunk);
          }
          if (!res.writableEnded) res.end();
          return { decision: "success", status: response.status, streamStarted: true };
        } catch {
          if (!res.writableEnded) res.end();
          return {
            decision: "return",
            status: controller.signal.aborted ? 499 : 502,
            error: controller.signal.aborted ? "The client disconnected." : "Gemini stream ended unexpectedly.",
            streamStarted: true,
            aborted: controller.signal.aborted,
          };
        }
      },
    });

    trackResult(
      req,
      {
        ok: Boolean(result.ok),
        data: result.data,
        error: result.error,
        status: result.status,
        usedKeyIndex: result.usedKeyIndex,
      },
      { type: isStreaming ? "openai_stream" : "openai_non_stream", model }
    );

    if (result.ok) {
      emitLive({
        type: "success",
        message: `موفق با کلید #${result.usedKeyIndex + 1}${isStreaming ? " (stream)" : ""}`,
        clientName,
        model,
        keyIndex: result.usedKeyIndex,
      });
      if (isStreaming) return;
      return res.status(result.status || 200).json(result.data);
    }
    if (res.headersSent) return;
    if (result.retryAfterMs > 0) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    }
    emitLive({
      type: result.allKeysExhausted ? "exhausted" : "fail",
      message: result.allKeysExhausted ? "تمام کلیدهای آماده موقتاً exhausted شدند" : result.error,
      clientName,
      model,
      status: result.status,
      keyIndex: result.usedKeyIndex,
    });
    return res.status(result.status || 502).json(
      result.data || {
        error: {
          message: result.error,
          allKeysExhausted: Boolean(result.allKeysExhausted),
        },
      }
    );
  } finally {
    req.removeListener("aborted", abortUpstream);
    res.removeListener("close", abortUpstream);
  }
});

// ----------------------------------------------------------------
// Gemini proxy (همون structure گوگل)
// ----------------------------------------------------------------
app.post("/v1beta/models/:modelAndMethod", requireClientAuth, async (req, res) => {
  const { modelAndMethod } = req.params;
  const [model, method] = modelAndMethod.split(":");

  if (!method) {
    return res.status(400).json({
      error: "فرمت مسیر باید model:method باشه، مثلا gemini-1.5-pro:generateContent",
    });
  }

  const pathUrl = `/v1beta/models/${modelAndMethod}`;
  const query = { ...req.query };
  delete query.key;
  const controller = new AbortController();
  const abortUpstream = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);

  emitLive({
    type: "request",
    message: `Gemini native: ${method}`,
    clientName: req.client?.name,
    model,
    detail: method,
  });

  if (method === "streamGenerateContent") {
    let streamStarted = false;

    const result = await callGeminiStream({
      keyManager,
      path: pathUrl,
      body: req.body,
      query,
      fetchImpl,
      baseUrl: env.GOOGLE_BASE_URL,
      signal: controller.signal,
      onStart: (keyIndex) => {
        streamStarted = true;
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        logger.log(`[stream] client=${req.client.name} key#${keyIndex}`);
        emitLive({
          type: "success",
          message: `استریم شروع شد با کلید #${keyIndex + 1}`,
          clientName: req.client?.name,
          model,
          keyIndex,
        });
      },
      onChunk: (chunk) => {
        res.write(chunk);
        if (typeof res.flush === "function") res.flush();
      },
    });

    trackResult(req, result, { type: "stream", model });

    if (!result.ok) {
      emitLive({
        type: result.allKeysExhausted ? "exhausted" : "fail",
        message: String(result.error || "خطای استریم").slice(0, 200),
        clientName: req.client?.name,
        model,
        keyIndex: result.usedKeyIndex,
        status: result.status,
      });
      if (!streamStarted && !res.headersSent) {
        if (result.retryAfterMs > 0) {
          res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
        }
        return res.status(result.status || 429).json({
          error: {
            message: result.error,
            allKeysExhausted: result.allKeysExhausted || false,
          },
        });
      }
      res.end();
      return;
    }

    res.end();
    return;
  }

  const result = await callGeminiNonStream({
    keyManager,
    path: pathUrl,
    body: req.body,
    query,
    fetchImpl,
    baseUrl: env.GOOGLE_BASE_URL,
    signal: controller.signal,
  });

  trackResult(req, result, { type: "non-stream", model });

  if (!result.ok) {
    emitLive({
      type: result.allKeysExhausted ? "exhausted" : "fail",
      message: String(result.error || "خطا").slice(0, 200),
      clientName: req.client?.name,
      model,
      keyIndex: result.usedKeyIndex,
      status: result.status,
    });
    if (result.retryAfterMs > 0) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil(result.retryAfterMs / 1000))));
    }
    return res.status(result.status || 429).json({
      error: {
        message: result.error,
        allKeysExhausted: result.allKeysExhausted || false,
      },
    });
  }

  emitLive({
    type: "success",
    message: `موفق با کلید #${(result.usedKeyIndex ?? 0) + 1}`,
    clientName: req.client?.name,
    model,
    keyIndex: result.usedKeyIndex,
  });

  return res.status(result.status).json(result.data);
});

app.get("/debug/keys-status", requireClientAuth, (req, res) => {
  res.json(keyManager.status());
});

app.use((err, req, res, next) => {
  logger.error(
    "[gemini-fallback-proxy] خطای پیش‌بینی‌نشده:",
    redactSensitive(err?.message || "unknown")
  );
  logError({
    type: "server_exception",
    message: err?.message || String(err),
    clientName: req.client?.name,
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "خطای داخلی سرور." });
});

function close() {
  clearInterval(loginCleanupTimer);
  for (const client of liveClients) {
    try {
      client.end();
    } catch {
      // The client is already gone.
    }
  }
  liveClients.clear();
  store.flush();
}

return {
  app,
  store,
  keyManager,
  stateEnvelope,
  interactionsClient,
  close,
};
}

export default createApp;
