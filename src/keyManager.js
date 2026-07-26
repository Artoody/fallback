// keyManager.js
// مسئول نگهداری لیست API key ها، وضعیت هرکدوم، و انتخاب کلید بعدی برای استفاده

const COOLDOWN_MS = parseInt(process.env.KEY_COOLDOWN_MS || "60000", 10);
// کلیدهای نامعتبر را مدت طولانی‌تری کنار می‌گذاریم تا مدام امتحان نشوند
const INVALID_KEY_COOLDOWN_MS = parseInt(process.env.INVALID_KEY_COOLDOWN_MS || String(24 * 60 * 60 * 1000), 10);

class KeyManager {
  constructor(keys) {
    if (!keys || keys.length === 0) {
      throw new Error("هیچ API keyـی تعریف نشده. مقدار GEMINI_API_KEYS رو در .env چک کن.");
    }
    // هر کلید یه آبجکت وضعیت داره: خودِ کلید، زمانی که تا اون موقع نباید استفاده بشه (بخاطر rate limit)، و شمارنده خطا
    this.keys = keys.map((key, idx) => ({
      key,
      index: idx,
      blockedUntil: 0, // اگه Date.now() از این کمتر باشه یعنی هنوز تو cooldown هست
      failCount: 0,
      lastUsed: 0,
    }));
  }

  // لیست کلیدهایی که الان قابل استفاده‌ان (تو cooldown نیستن)، به ترتیب اولویت و نوبت در صف
  getAvailableOrder() {
    const now = Date.now();
    const free = this.keys.filter((k) => k.blockedUntil <= now);
    const blocked = this.keys.filter((k) => k.blockedUntil > now && !k.invalid);
    const invalid = this.keys.filter((k) => k.invalid && k.blockedUntil > now);
    // اول کلیدهای سالم، بعد rate-limited، آخر نامعتبرها
    return [...free, ...blocked, ...invalid];
  }

  markSuccess(keyObj) {
    keyObj.failCount = 0;
    keyObj.blockedUntil = 0;
    keyObj.invalid = false;
    keyObj.lastUsed = Date.now();
    this.#moveToEnd(keyObj);
  }

  markRateLimited(keyObj) {
    keyObj.failCount += 1;
    keyObj.blockedUntil = Date.now() + COOLDOWN_MS;
    keyObj.invalid = false;
    this.#moveToEnd(keyObj);
  }

  /** کلید نامعتبر (API_KEY_INVALID) — cooldown طولانی + اولویت آخر */
  markInvalid(keyObj) {
    keyObj.failCount += 1;
    keyObj.invalid = true;
    keyObj.blockedUntil = Date.now() + INVALID_KEY_COOLDOWN_MS;
    this.#moveToEnd(keyObj);
    console.warn(`[keyManager] کلید #${keyObj.index} نامعتبر تشخیص داده شد و موقتاً کنار گذاشته شد.`);
  }

  #moveToEnd(keyObj) {
    const idx = this.keys.indexOf(keyObj);
    if (idx !== -1) {
      this.keys.splice(idx, 1);
      this.keys.push(keyObj);
    }
  }

  status() {
    const now = Date.now();
    return this.keys.map((k) => ({
      index: k.index,
      keyPreview: k.key.slice(0, 6) + "...",
      blocked: k.blockedUntil > now,
      blockedForMs: Math.max(0, k.blockedUntil - now),
      failCount: k.failCount,
      invalid: Boolean(k.invalid),
    }));
  }

  /** همگام‌سازی لیست کلیدها با store (بدون از دست دادن وضعیت cooldown کلیدهای موجود) */
  syncKeys(newKeys) {
    const unique = [...new Set((newKeys || []).map((k) => String(k).trim()).filter(Boolean))];
    if (unique.length === 0) {
      throw new Error("حداقل یک کلید Gemini لازم است.");
    }
    const existingByKey = new Map(this.keys.map((k) => [k.key, k]));
    this.keys = unique.map((key, idx) => {
      const prev = existingByKey.get(key);
      if (prev) {
        return { ...prev, index: idx, key };
      }
      return {
        key,
        index: idx,
        blockedUntil: 0,
        failCount: 0,
        lastUsed: 0,
      };
    });
  }

  addKey(key) {
    const k = String(key).trim();
    if (!k) throw new Error("کلید خالی است.");
    if (this.keys.some((x) => x.key === k)) throw new Error("این کلید از قبل وجود دارد.");
    this.keys.push({
      key: k,
      index: this.keys.length,
      blockedUntil: 0,
      failCount: 0,
      lastUsed: 0,
    });
  }

  removeKeyAt(index) {
    if (index < 0 || index >= this.keys.length) throw new Error("ایندکس نامعتبر است.");
    if (this.keys.length <= 1) throw new Error("حداقل یک کلید باید باقی بماند.");
    this.keys.splice(index, 1);
    this.keys.forEach((k, i) => {
      k.index = i;
    });
  }
}

export default KeyManager;
