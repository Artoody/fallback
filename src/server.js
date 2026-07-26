// server.js
// پروکسی Gemini با fallback بین چند کلید + پنل ادمین برای دانش‌آموزان

import "dotenv/config";
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import KeyManager from "./keyManager.js";
import Store from "./store.js";
import { callGeminiNonStream, callGeminiStream } from "./geminiClient.js";

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

function requireAdmin(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD روی سرور تنظیم نشده." });
  }
  const header = req.get("x-admin-password") || "";
  const authHeader = req.get("authorization");
  const bearer = authHeader && authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
  const provided = header || bearer;
  if (!provided || provided !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "رمز ادمین نامعتبر است." });
  }
  next();
}

function trackResult(req, result) {
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
app.post("/admin/api/login", (req, res) => {
  const password = req.body?.password;
  if (!ADMIN_PASSWORD) {
    return res.status(500).json({ error: "ADMIN_PASSWORD روی سرور تنظیم نشده." });
  }
  if (!password || password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: "رمز اشتباه است." });
  }
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

    trackResult(req, result);

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

  trackResult(req, result);

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

const PORT = process.env.PORT || 8080;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[gemini-fallback-proxy] سرور روی پورت ${PORT} بالا اومد.`);
  console.log(`[gemini-fallback-proxy] پنل ادمین: http://0.0.0.0:${PORT}/admin/`);
});
