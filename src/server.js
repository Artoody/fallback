import "dotenv/config";
import createApp from "./app.js";

const port = Number(process.env.PORT || 8080);
const runtime = createApp();
const server = runtime.app.listen(port, "0.0.0.0", () => {
  console.log(`[gemini-fallback-proxy] سرور روی پورت ${port} بالا اومد.`);
  console.log(`[gemini-fallback-proxy] پنل ادمین: http://0.0.0.0:${port}/admin/`);
});

function gracefulShutdown(signal) {
  console.log(`[gemini-fallback-proxy] دریافت ${signal}؛ در حال خاموش شدن...`);
  server.close(() => {
    try {
      runtime.close();
    } catch (error) {
      console.error("[gemini-fallback-proxy] خطا در flush کردن store:", error.message);
    }
    process.exit(0);
  });
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
