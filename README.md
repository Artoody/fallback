# Gemini Fallback Proxy

یه پروکسی ساده که چند تا API key گوگل جمینای می‌گیره و وقتی یکی rate-limit (429) خورد یا خطای موقتی سرور (500/503) داد، خودکار میره سراغ کلید بعدی.

این gateway حالا یک لایهٔ سازگاری native برای Codex هم دارد: `GET /v1/models`
کاتالوگ مدل‌های Codex را برمی‌گرداند و `POST /v1/responses` درخواست‌های Responses
را به Gemini Interactions ترجمه می‌کند. راه‌اندازی، محدودیت‌ها و checklist انتشار در
[راهنمای Codex](docs/codex.md) آمده است.

## نصب و اجرا

```bash
cd gemini-fallback-proxy
npm install
cp .env.example .env
# حالا .env رو باز کن و کلیدهات رو داخل GEMINI_API_KEYS بذار (با کاما جدا کن)
npm start
```

سرور روی `http://localhost:8080` بالا میاد.

## احراز هویت (محافظت از سرور خودت)

توی `.env` یه مقدار امن و رندوم برای `PROXY_API_KEY` بذار (مثلا با `openssl rand -hex 32`).
از این به بعد **هر request** (به جز مسیر `/` که فقط health-check ساده‌ست) باید این کلید رو در یکی از این دو هدر بفرسته، وگرنه با خطای `401` رد میشه:

```
x-api-key: YOUR_PROXY_SECRET
```
یا
```
Authorization: Bearer YOUR_PROXY_SECRET
```

اگه `PROXY_API_KEY` رو تنظیم نکنی، سرور با هشدار بالا میاد و همه request ها با خطای 500 رد میشن (تا از دسترسی آزاد جلوگیری بشه).

## نحوه استفاده در کد فعلیت

فقط کافیه base URL رو عوض کنی، هدر `x-api-key` خودت رو اضافه کنی، و دیگه لازم نیست به گوگل `key` بفرستی (پروکسی خودش کلید مناسب رو انتخاب می‌کنه). ساختار request/response دقیقاً همونیه که خود گوگل داره.

### قبل (مستقیم به گوگل):
```
POST https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-pro:generateContent?key=YOUR_GOOGLE_KEY
```

### بعد (از طریق پروکسی خودت):
```
POST http://localhost:8080/v1beta/models/gemini-1.5-pro:generateContent
x-api-key: YOUR_PROXY_SECRET
```

بدنه (body) درخواست دقیقاً همون JSON استانداردیه که برای Gemini می‌فرستادی، هیچ تغییری لازم نیست:

```json
{
  "contents": [
    { "parts": [{ "text": "سلام، حالت چطوره؟" }] }
  ]
}
```

پاسخ هم دقیقاً همون فرمت خروجی گوگله.

### حالت Stream

برای stream، همون مسیر `:streamGenerateContent` رو صدا بزن، پروکسی به صورت SSE جواب رو pipe می‌کنه — دقیقاً مثل خود گوگل.

```
POST http://localhost:8080/v1beta/models/gemini-1.5-pro:streamGenerateContent
```

### مثال کامل با curl

```bash
curl -X POST http://localhost:8080/v1beta/models/gemini-1.5-pro:generateContent \
  -H "Content-Type: application/json" \
  -H "x-api-key: YOUR_PROXY_SECRET" \
  -d '{
    "contents": [{ "parts": [{ "text": "سلام" }] }]
  }'
```

## بررسی وضعیت کلیدها

```
GET http://localhost:8080/debug/keys-status
x-api-key: YOUR_PROXY_SECRET
```

(این مسیر هم پشت auth هست، پس باید هدر رو بفرستی.)

خروجی نشون میده کدوم کلید الان بلاک (در cooldown) هست و چند بار خطا داده.

## منطق fallback

1. درخواست با کلید فعلی (round-robin) ارسال میشه.
2. اگه کد پاسخ `429` یا `500`/`502`/`503`/`504` باشه → اون کلید به مدت `KEY_COOLDOWN_MS` (پیش‌فرض ۶۰ ثانیه) کنار گذاشته میشه و کلید بعدی امتحان میشه.
3. اگه خطای دیگه‌ای باشه (مثلاً `400` - درخواست نامعتبر) → همون خطا مستقیم به کلاینت برمی‌گرده، چون تعویض کلید کمکی نمی‌کنه.
4. کلید نامعتبرِ تأییدشده cooldown طولانی‌تری می‌گیرد. اگر هیچ کلیدی آماده نباشد، پاسخ `429` همراه `Retry-After` برمی‌گردد.
5. بعد از شروع stream هیچ requestی با کلید دیگری replay نمی‌شود.

## نکات برای Production

- بهتره این سرور رو پشت یه HTTPS reverse-proxy (مثل Nginx یا Caddy) بذاری، چون بدون HTTPS، هدر `x-api-key` رمزنگاری نمیشه و قابل شنود روی شبکه‌ست.
- می‌تونی `KEY_COOLDOWN_MS` رو بر اساس quota واقعی هر کلید تنظیم کنی.
- برای مقیاس بزرگتر، وضعیت کلیدها رو به جای in-memory تو Redis نگه دار (اگه چند instance از سرور داری).
- `PROXY_API_KEY` رو حتما طولانی و رندوم بذار (حداقل 32 بایت) و هیچ‌وقت تو کد یا Git commit نکن؛ فقط تو `.env` (که باید تو `.gitignore` باشه).
- اگه چند نفر/چند سرویس می‌خوان از این پروکسی استفاده کنن، می‌تونی به جای یک کلید ثابت، لیستی از کلیدهای مجاز با نام‌های مختلف تعریف کنی تا بدونی کدوم مصرف‌کننده چقدر استفاده کرده (rate limiting per client).
