// server.js
// پروکسی Gemini با fallback بین چند کلید + پنل ادمین برای دانش‌آموزان

import "dotenv/config";
import crypto from "crypto";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import KeyManager from "./keyManager.js";
import Store from "./store.js";
import { callGeminiNonStream, callGeminiStream, listGeminiModels, testSingleGeminiKey } from "./geminiClient.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "50mb" }));

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const PROXY_API_KEY = process.env.PROXY_API_KEY;

const envGeminiKeys = (process.env.GEMINI_API_KEYS || "")
  .split(/[,\n\r]+/)
  .map((k) => k.trim().replace(/^["']+|["']+$/g, "").trim())
  .filter(Boolean);

const store = new Store();
store.seedFromEnv({ geminiKeys: envGeminiKeys, proxyApiKey: PROXY_API_KEY });

// اگر در env کلید Gemini باشد، همان منبع حقیقت است (برای Runflare مهم است)
if (envGeminiKeys.length > 0) {
  store.setGeminiKeys(envGeminiKeys);
}

const geminiKeys = store.getGeminiKeys();
if (!geminiKeys.length) {
  throw new Error("هیچ کلید Geminiای تعریف نشده. GEMINI_API_KEYS یا پنل ادمین را چک کن.");
}

const keyManager = new KeyManager(geminiKeys);
console.log(`[gemini-fallback-proxy] ${geminiKeys.length} کلید Gemini بارگذاری شد.`);
console.log(
  `[gemini-fallback-proxy] نمونه کلیدها: ` +
    geminiKeys
      .slice(0, 3)
      .map((k, i) => `#${i}:${k.slice(0, 8)}…`)
      .join(" ")
);
console.log(`[gemini-fallback-proxy] ${store.listClients().length} کلید دانش‌آموز فعال است.`);

if (!ADMIN_PASSWORD) {
  console.warn(
    "[gemini-fallback-proxy] هشدار: ADMIN_PASSWORD تنظیم نشده. پنل /admin قفل می‌ماند تا مقدار بگذاری."
  );
}

// ----------------------------------------------------------------
// Auth: هر کلید دانش‌آموز (و PROXY_API_KEY قدیمی) معتبر است
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

  let client = store.findClientByKey(providedKey);

  // سازگاری با PROXY_API_KEY قدیمی اگر هنوز در store نباشد
  if (!client && PROXY_API_KEY && providedKey === PROXY_API_KEY) {
    client = {
      id: "env-proxy",
      name: "کلید اصلی (.env)",
      key: PROXY_API_KEY,
      enabled: true,
      stats: {},
    };
  }

  if (!client) {
    return res.status(401).json({ error: { message: "دسترسی غیرمجاز. کلید API معتبر ارسال نشده." } });
  }

  req.client = client;
  next();
}

// مقایسه‌ی امن (constant-time) برای جلوگیری از timing attack روی رمز ادمین
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ""));
  const bufB = Buffer.from(String(b || ""));
  if (bufA.length !== bufB.length) {
    // طول‌های متفاوت را هم با یه مقایسه‌ی بی‌معنی هم‌طول انجام می‌دیم تا زمان‌سنجی لو نده
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// ----------------------------------------------------------------
// Rate limit ساده برای /admin/api/login: هر IP حداکثر 5 تلاش در 15 دقیقه
// ----------------------------------------------------------------
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_ATTEMPTS = 5;
const loginAttempts = new Map(); // ip -> { count, resetAt }

function loginRateLimiter(req, res, next) {
  const ip = req.ip || req.connection?.remoteAddress || "unknown";
  const now = Date.now();
  let entry = loginAttempts.get(ip);

  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + LOGIN_WINDOW_MS };
    loginAttempts.set(ip, entry);
  }

  if (entry.count >= LOGIN_MAX_ATTEMPTS) {
    const waitSec = Math.ceil((entry.resetAt - now) / 1000);
    return res.status(429).json({
      error: `تعداد تلاش‌های ورود بیش از حد مجاز است. ${waitSec} ثانیه دیگر دوباره امتحان کن.`,
    });
  }

  entry.count += 1;
  req._loginEntry = entry;
  next();
}

// هر ۱۰ دقیقه IP‌های منقضی‌شده رو پاک کن تا Map بی‌نهایت بزرگ نشه
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (entry.resetAt <= now) loginAttempts.delete(ip);
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
// لاگ خطاهای اخیر — در حافظه نگه می‌داریم (آخرین ۱۰۰ تا) تا تو پنل ادمین دیده بشن
// ----------------------------------------------------------------
const MAX_ERROR_LOG = 100;
const errorLog = [];

function logError({ type, message, clientName, model, status, keyIndex }) {
  errorLog.unshift({
    time: new Date().toISOString(),
    type: type || "unknown",
    message: String(message || "").slice(0, 500),
    clientName: clientName || null,
    model: model || null,
    status: status || null,
    keyIndex: keyIndex ?? null,
  });
  if (errorLog.length > MAX_ERROR_LOG) errorLog.length = MAX_ERROR_LOG;
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
  // ورود موفق بود؛ شمارنده‌ی تلاش‌های این IP رو ریست کن
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

// افزودن دسته‌ای — چند کلید با هم، جدا شده با کاما یا خط جدید (دقیقاً مثل فرمت GEMINI_API_KEYS تو .env)
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

// تست سریع یه کلید مشخص Gemini — کنار همون کلید تو پنل، بدون نیاز به نوشتن پرامپت
app.post("/admin/api/gemini-keys/:index/test", requireAdmin, async (req, res) => {
  try {
    const index = Number(req.params.index);
    const keys = store.getGeminiKeys();
    if (index < 0 || index >= keys.length) {
      return res.status(400).json({ error: "ایندکس نامعتبر است." });
    }
    const result = await testSingleGeminiKey(keys[index]);
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

// آخرین خطاهای ثبت‌شده (فراخوانی‌های ناموفق Gemini + خطاهای عمومی سرور)
app.get("/admin/api/errors", requireAdmin, (req, res) => {
  res.json({ errors: errorLog });
});

app.delete("/admin/api/errors", requireAdmin, (req, res) => {
  errorLog.length = 0;
  res.json({ ok: true });
});

// لیست مدل‌های موجود Gemini (برای پر کردن dropdown پنل تست)
app.get("/admin/api/models", requireAdmin, async (req, res) => {
  const result = await listGeminiModels({ keyManager });
  if (!result.ok) {
    return res.status(result.status || 500).json({ error: result.error });
  }
  res.json({ models: result.data?.models || [] });
});

// دکمه‌ی "Test API" پنل ادمین: یه پرامپت واقعی از طریق همین پروکسی به Gemini می‌فرسته
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
// Gemini proxy (همون structure گوگل) — همه دانش‌آموزها به یک استخر کلید وصلن
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

  if (method === "streamGenerateContent") {
    let streamStarted = false;

    const result = await callGeminiStream({
      keyManager,
      path: pathUrl,
      body: req.body,
      query,
      onStart: (keyIndex) => {
        streamStarted = true;
        // فقط وقتی استریم گوگل واقعاً شروع شد SSE می‌فرستیم
        // اگر زودتر بفرستیم، Cline روی "thinking" گیر می‌کند
        res.status(200);
        res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        res.setHeader("Cache-Control", "no-cache, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        if (typeof res.flushHeaders === "function") res.flushHeaders();
        console.log(`[stream] client=${req.client.name} key#${keyIndex}`);
      },
      onChunk: (chunk) => {
        res.write(chunk);
        if (typeof res.flush === "function") res.flush();
      },
    });

    trackResult(req, result, { type: "stream", model });

    if (!result.ok) {
      if (!streamStarted && !res.headersSent) {
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
  });

  trackResult(req, result, { type: "non-stream", model });

  if (!result.ok) {
    return res.status(result.status || 429).json({
      error: {
        message: result.error,
        allKeysExhausted: result.allKeysExhausted || false,
      },
    });
  }

  return res.status(result.status).json(result.data);
});

app.get("/debug/keys-status", requireClientAuth, (req, res) => {
  res.json(keyManager.status());
});

// هندلر عمومی خطا — هر throw/exception پیش‌بینی‌نشده رو می‌گیره، لاگ می‌کنه و 500 برمی‌گردونه
// (باید آخرین app.use باشه، بعد از همه‌ی route ها)
app.use((err, req, res, next) => {
  console.error("[gemini-fallback-proxy] خطای پیش‌بینی‌نشده:", err);
  logError({
    type: "server_exception",
    message: err?.message || String(err),
    clientName: req.client?.name,
  });
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "خطای داخلی سرور." });
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[gemini-fallback-proxy] سرور روی پورت ${PORT} بالا اومد.`);
  console.log(`[gemini-fallback-proxy] پنل ادمین: http://0.0.0.0:${PORT}/admin/`);
});

// قبل از خاموش شدن (redeploy/SIGTERM)، هر نوشتن دیسک معلق رو فوراً flush کن تا آمار گم نشه
function gracefulShutdown(signal) {
  console.log(`[gemini-fallback-proxy] دریافت ${signal}؛ در حال flush کردن store...`);
  try {
    store.flush();
  } catch (err) {
    console.error("[gemini-fallback-proxy] خطا در flush کردن store:", err.message);
  }
  process.exit(0);
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
