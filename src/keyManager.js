// keyManager.js
// مسئول نگهداری لیست API key ها، وضعیت هرکدوم، و انتخاب کلید بعدی برای استفاده

class KeyManager {
  constructor(
    keys,
    {
      cooldownMs = parseInt(process.env.KEY_COOLDOWN_MS || "60000", 10),
      invalidKeyCooldownMs = parseInt(
        process.env.INVALID_KEY_COOLDOWN_MS || String(24 * 60 * 60 * 1000),
        10
      ),
      now = () => Date.now(),
    } = {}
  ) {
    if (!keys || keys.length === 0) {
      throw new Error("هیچ API keyـی تعریف نشده. مقدار GEMINI_API_KEYS رو در .env چک کن.");
    }
    this.cooldownMs = cooldownMs;
    this.invalidKeyCooldownMs = invalidKeyCooldownMs;
    this.now = now;
    this.nextStartIndex = 0;
    // هر کلید یه آبجکت وضعیت داره: خودِ کلید، زمانی که تا اون موقع نباید استفاده بشه (بخاطر rate limit)، و شمارنده خطا
    this.keys = keys.map((key, idx) => ({
      key,
      index: idx,
      blockedUntil: 0, // اگه Date.now() از این کمتر باشه یعنی هنوز تو cooldown هست
      failCount: 0,
      lastUsed: 0,
    }));
  }

  /**
   * یک snapshot از کلیدهای آماده می‌سازد. نقطه شروع برای هر درخواست جلو
   * می‌رود تا درخواست‌های همزمان همگی روی کلید اول stampede نکنند.
   * کلیدهای cooldown شده هرگز در snapshot برگردانده نمی‌شوند.
   */
  getAvailableOrder() {
    const now = this.now();
    const total = this.keys.length;
    const ordered = [];

    for (let offset = 0; offset < total; offset += 1) {
      const position = (this.nextStartIndex + offset) % total;
      const keyObj = this.keys[position];
      if (keyObj.blockedUntil <= now) ordered.push(keyObj);
    }

    this.nextStartIndex = (this.nextStartIndex + 1) % total;
    return ordered;
  }

  retryAfterMs() {
    const now = this.now();
    const waits = this.keys
      .map((keyObj) => Math.max(0, keyObj.blockedUntil - now))
      .filter((wait) => wait > 0);
    return waits.length > 0 ? Math.min(...waits) : 0;
  }

  markSuccess(keyObj) {
    keyObj.failCount = 0;
    keyObj.blockedUntil = 0;
    keyObj.invalid = false;
    keyObj.lastUsed = this.now();
  }

  markRateLimited(keyObj, cooldownMs = this.cooldownMs) {
    keyObj.failCount += 1;
    keyObj.blockedUntil = this.now() + cooldownMs;
    keyObj.invalid = false;
  }

  /** کلید نامعتبر (API_KEY_INVALID) — cooldown طولانی + اولویت آخر */
  markInvalid(keyObj) {
    keyObj.failCount += 1;
    keyObj.invalid = true;
    keyObj.blockedUntil = this.now() + this.invalidKeyCooldownMs;
    console.warn(`[keyManager] کلید #${keyObj.index} نامعتبر تشخیص داده شد و موقتاً کنار گذاشته شد.`);
  }

  status() {
    const now = this.now();
    return this.keys.map((k) => ({
      index: k.index,
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
    this.nextStartIndex %= this.keys.length;
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
    this.nextStartIndex %= this.keys.length;
  }
}

export default KeyManager;
