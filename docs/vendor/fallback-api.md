# راهنمای ساده — Gemini Fallback Proxy

این سرور یک **پروکسی** است: تو به پروکسی درخواست می‌فرستی، پروکسی با چند کلید Google Gemini کار می‌کند و اگر یکی خطا یا rate-limit بخورد، خودش کلید بعدی را امتحان می‌کند.

---

## ۱. آدرس سرور (Base URL)

فقط **دامنهٔ سرور** را بگذار، بدون `/v1beta` و بدون `/` آخر:

| محیط | Base URL |
|------|----------|
| Railway (مثال) | `https://fallback-production.up.railway.app` |
| سرور دیگر | `https://YOUR-SERVER.up.railway.app` |

---

## ۲. دو نوع کلید (مهم)

| نوع | کاربرد | مثال |
|-----|--------|------|
| **کلید پروکسی (دانش‌آموز / Cline)** | در برنامهٔ خودت (Cline، اسکریپت، …) | از پنل ادمین ساخته می‌شود |
| **کلید Gemini** | فقط داخل سرور (env یا پنل ادمین) | `AIzaSy…` یا توکن‌های `AQ.…` |

**هرگز** کلید Gemini گوگل را مستقیم در Cline به‌جای کلید پروکسی نگذار.

---

## ۳. استفاده در Cline (یا هر کلاینت سازگار با Gemini API)

1. **Base URL:** `https://YOUR-SERVER` (بدون `/v1beta`)

2. **API Key:** کلید پروکسی (از پنل `/admin`)

3. مسیر API مثل خود Gemini است، فقط host عوض شده:

```http
POST https://YOUR-SERVER/v1beta/models/gemini-2.5-flash:generateContent
Content-Type: application/json
x-goog-api-key: YOUR_PROXY_KEY

{
  "contents": [{ "parts": [{ "text": "سلام" }] }]
}
```

هدرهای جایگزین برای کلید پروکسی:

- `x-api-key: YOUR_PROXY_KEY`
- `Authorization: Bearer YOUR_PROXY_KEY`
- `?key=YOUR_PROXY_KEY` در query string

**Stream:** همان مسیر با `:streamGenerateContent` (مثل API گوگل).

---

## ۴. پنل ادمین

| مورد | مقدار |
|------|--------|
| آدرس | `https://YOUR-SERVER/admin/` |
| رمز | همان `ADMIN_PASSWORD` روی سرور |

از پنل می‌توانی:

- کلید Gemini اضافه / حذف کنی
- برای هر نفر **کلید پروکسی** بسازی و مصرف را ببینی

---

## ۵. راه‌اندازی روی سرور جدید (خلاصه)

### Railway

1. ریپو: https://github.com/Artoody/fallback  
2. پروژهٔ Railway → Deploy from GitHub (branch `main`)  
3. در **Variables** حداقل:

```env
PORT=8080
ADMIN_PASSWORD=یک_رمز_قوی
PROXY_API_KEY=یک_رشته_رندوم_طولانی
GEMINI_API_KEYS=کلید1,کلید2,کلید3
GOOGLE_BASE_URL=https://generativelanguage.googleapis.com
KEY_COOLDOWN_MS=60000
```

4. **Networking** → Generate Domain → همان دامنه را در کلاینت به‌عنوان Base URL بزن.

### VPS

```bash
git clone https://github.com/Artoody/fallback.git
cd fallback
npm install
cp .env.example .env
npm start
```

پشت Nginx/Caddy با HTTPS؛ پورت داخلی معمولاً `8080`.

---

## ۶. چک سلامت

```http
GET https://YOUR-SERVER/
```

پاسخ نمونه:

```json
{
  "status": "ok",
  "message": "Gemini fallback proxy در حال اجراست.",
  "admin": "/admin/",
  "geminiKeys": 16,
  "clients": 3
}
```

---

## ۷. چند سرور همزمان

| سرور | Base URL در کلاینت | کلید پروکسی |
|------|-------------------|-------------|
| A | دامنهٔ سرور A | کلید ساخته‌شده در پنل A |
| B | دامنهٔ سرور B | کلید ساخته‌شده در پنل B |

هر سرور **store و کلیدهای خودش** را دارد؛ کلید پروکسی سرور A روی سرور B کار نمی‌کند.

---

## ۸. خطاهای رایج

| خطا | علت احتمالی |
|-----|-------------|
| 401 دسترسی غیرمجاز | کلید پروکسی اشتباه یا برای سرور دیگر است |
| 502 / همه کلیدها fail | کلیدهای Gemini روی سرور منقضی یا اشتباه |
| کلاینت گیر می‌کند | Base URL اشتباه (`/v1beta` نباید داخل Base URL باشد) |

---

## ۹. خلاصه

**Base URL = دامنه پروکسی · API Key = کلید پروکسی از ادمین · مسیر API = مثل Gemini (`/v1beta/models/...`)**
