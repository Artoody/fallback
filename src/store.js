// store.js — ذخیره پایدار کلیدهای Gemini و کلیدهای دانش‌آموز (proxy clients)

import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "..", "data");
const STORE_PATH = path.join(DATA_DIR, "store.json");

function emptyStore() {
  return { geminiKeys: [], clients: [] };
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadRaw() {
  ensureDir();
  if (!fs.existsSync(STORE_PATH)) {
    return emptyStore();
  }
  try {
    const raw = fs.readFileSync(STORE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    return {
      geminiKeys: Array.isArray(parsed.geminiKeys) ? parsed.geminiKeys : [],
      clients: Array.isArray(parsed.clients) ? parsed.clients : [],
    };
  } catch {
    console.warn("[store] خواندن store.json ناموفق بود؛ از صفر شروع می‌کنیم.");
    return emptyStore();
  }
}

function saveRaw(data) {
  ensureDir();
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), "utf8");
}

// نوشتن روی دیسک با تاخیر و دسته‌ای (debounce) — به‌جای نوشتن روی هر درخواست تکی
const PERSIST_DEBOUNCE_MS = parseInt(process.env.STORE_PERSIST_DEBOUNCE_MS || "2000", 10);

function generateKey() {
  return crypto.randomBytes(32).toString("hex");
}

function newClientStats() {
  return {
    requests: 0,
    success: 0,
    errors: 0,
    lastUsedAt: null,
    promptTokens: 0,
    candidatesTokens: 0,
    totalTokens: 0,
  };
}

class Store {
  constructor() {
    this.data = loadRaw();
    this._persistTimer = null;
  }

  /** نوشتن فوری و همزمان روی دیسک (برای تغییرات مهم مثل ساخت/حذف کلاینت) */
  persist() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    saveRaw(this.data);
  }

  /** نوشتن با تاخیر (برای آمار پرتکرار مثل recordUsage) — چند رخداد را در یک نوشتن دیسک جمع می‌کند */
  persistDebounced() {
    if (this._persistTimer) return;
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      saveRaw(this.data);
    }, PERSIST_DEBOUNCE_MS);
    if (typeof this._persistTimer.unref === "function") this._persistTimer.unref();
  }

  /** فلاش اجباری قبل از خاموش شدن پروسه */
  flush() {
    if (this._persistTimer) {
      clearTimeout(this._persistTimer);
      this._persistTimer = null;
    }
    saveRaw(this.data);
  }

  // ---------- Gemini keys ----------
  getGeminiKeys() {
    return [...this.data.geminiKeys];
  }

  setGeminiKeys(keys) {
    this.data.geminiKeys = keys
      .map((k) => String(k).trim().replace(/^["']+|["']+$/g, "").trim())
      .filter(Boolean);
    this.persist();
    return this.getGeminiKeys();
  }

  addGeminiKey(key) {
    const k = String(key).trim().replace(/^["']+|["']+$/g, "").trim();
    if (!k) throw new Error("کلید خالی است.");
    if (this.data.geminiKeys.includes(k)) throw new Error("این کلید از قبل وجود دارد.");
    this.data.geminiKeys.push(k);
    this.persist();
    return this.getGeminiKeys();
  }

  removeGeminiKey(keyOrIndex) {
    if (typeof keyOrIndex === "number") {
      if (keyOrIndex < 0 || keyOrIndex >= this.data.geminiKeys.length) {
        throw new Error("ایندکس نامعتبر است.");
      }
      this.data.geminiKeys.splice(keyOrIndex, 1);
    } else {
      const idx = this.data.geminiKeys.indexOf(String(keyOrIndex).trim());
      if (idx === -1) throw new Error("کلید پیدا نشد.");
      this.data.geminiKeys.splice(idx, 1);
    }
    this.persist();
    return this.getGeminiKeys();
  }

  listGeminiKeysMasked() {
    return this.data.geminiKeys.map((k, index) => ({
      index,
      preview: k.slice(0, 8) + "…" + k.slice(-4),
      length: k.length,
    }));
  }

  // ---------- Clients (proxy keys for students) ----------
  listClients() {
    return this.data.clients.map((c) => ({
      id: c.id,
      name: c.name,
      key: c.key,
      keyPreview: c.key.slice(0, 8) + "…" + c.key.slice(-4),
      enabled: c.enabled !== false,
      createdAt: c.createdAt,
      stats: { ...newClientStats(), ...(c.stats || {}) },
    }));
  }

  findClientByKey(key) {
    if (!key) return null;
    return this.data.clients.find((c) => c.key === key && c.enabled !== false) || null;
  }

  createClient(name, { key } = {}) {
    const n = String(name || "").trim();
    if (!n) throw new Error("نام دانش‌آموز الزامی است.");
    const clientKey = key && String(key).trim() ? String(key).trim() : generateKey();
    if (this.data.clients.some((c) => c.key === clientKey)) {
      throw new Error("این کلید قبلاً استفاده شده.");
    }
    const client = {
      id: crypto.randomUUID(),
      name: n,
      key: clientKey,
      enabled: true,
      createdAt: new Date().toISOString(),
      stats: newClientStats(),
    };
    this.data.clients.push(client);
    this.persist();
    return { ...client, keyPreview: client.key.slice(0, 8) + "…" + client.key.slice(-4) };
  }

  updateClient(id, patch = {}) {
    const client = this.data.clients.find((c) => c.id === id);
    if (!client) throw new Error("دانش‌آموز پیدا نشد.");
    if (patch.name !== undefined) {
      const n = String(patch.name).trim();
      if (!n) throw new Error("نام خالی مجاز نیست.");
      client.name = n;
    }
    if (patch.enabled !== undefined) client.enabled = Boolean(patch.enabled);
    this.persist();
    return this.listClients().find((c) => c.id === id);
  }

  regenerateClientKey(id) {
    const client = this.data.clients.find((c) => c.id === id);
    if (!client) throw new Error("دانش‌آموز پیدا نشد.");
    let newKey;
    do {
      newKey = generateKey();
    } while (this.data.clients.some((c) => c.key === newKey));
    client.key = newKey;
    this.persist();
    return this.listClients().find((c) => c.id === id);
  }

  deleteClient(id) {
    const idx = this.data.clients.findIndex((c) => c.id === id);
    if (idx === -1) throw new Error("دانش‌آموز پیدا نشد.");
    this.data.clients.splice(idx, 1);
    this.persist();
  }

  recordUsage(clientId, { ok, usageMetadata } = {}) {
    const client = this.data.clients.find((c) => c.id === clientId);
    if (!client) return;
    if (!client.stats) client.stats = newClientStats();
    client.stats.requests += 1;
    if (ok) client.stats.success += 1;
    else client.stats.errors += 1;
    client.stats.lastUsedAt = new Date().toISOString();
    if (usageMetadata && typeof usageMetadata === "object") {
      client.stats.promptTokens += Number(usageMetadata.promptTokenCount || 0);
      client.stats.candidatesTokens += Number(usageMetadata.candidatesTokenCount || 0);
      client.stats.totalTokens += Number(usageMetadata.totalTokenCount || 0);
    }
    this.persistDebounced();
  }

  /** seed اولیه از env اگر store خالی باشد */
  seedFromEnv({ geminiKeys = [], proxyApiKey } = {}) {
    let changed = false;
    if (this.data.geminiKeys.length === 0 && geminiKeys.length > 0) {
      this.data.geminiKeys = [...geminiKeys];
      changed = true;
      console.log(`[store] ${geminiKeys.length} کلید Gemini از env به store منتقل شد.`);
    }
    if (
      proxyApiKey &&
      proxyApiKey !== "CHANGE_ME_TO_A_LONG_RANDOM_SECRET" &&
      !this.data.clients.some((c) => c.key === proxyApiKey)
    ) {
      this.data.clients.push({
        id: crypto.randomUUID(),
        name: "کلید اصلی (.env)",
        key: proxyApiKey,
        enabled: true,
        createdAt: new Date().toISOString(),
        stats: newClientStats(),
      });
      changed = true;
      console.log("[store] PROXY_API_KEY از env به‌عنوان کلاینت اولیه ثبت شد.");
    }
    if (changed) this.persist();
  }
}

export { generateKey };
export default Store;
