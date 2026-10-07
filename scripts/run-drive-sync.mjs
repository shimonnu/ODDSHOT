import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { setTimeout } from "node:timers/promises";

if (existsSync(".env.local")) loadEnvFile(".env.local");
if (process.env.ODDSHOT_DRIVE_MODE !== "google" || (process.env.ODDSHOT_SYNC_SECRET?.trim().length ?? 0) < 32) {
  console.error("Google Drive 同期の設定を確認してください。");
  process.exit(1);
}
const callback = new URL(process.env.ODDSHOT_SYNC_CALLBACK_URL?.trim() || "http://127.0.0.1:3001/api/admin/drive/process");
if (callback.username || callback.password || callback.hash || callback.search || callback.pathname !== "/api/admin/drive/process"
  || !(callback.protocol === "https:" || (callback.protocol === "http:" && ["127.0.0.1", "localhost"].includes(callback.hostname)))) {
  console.error("Google Drive 同期の呼び出し先を確認してください。");
  process.exit(1);
}

let running = true;
const controller = new AbortController();
for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { running = false; controller.abort(); });
console.log("Google Drive の未保存写真を30秒ごとに確認します。");
while (running) {
  try {
    const response = await fetch(callback, {
      method: "POST", redirect: "error", headers: { Authorization: `Bearer ${process.env.ODDSHOT_SYNC_SECRET.trim()}` },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(290_000)]),
    });
    if (!response.ok) console.error(JSON.stringify({ event: "drive_dispatch_failed", status: response.status }));
    else {
      const result = await response.json();
      if (result.processed > 0) console.log(JSON.stringify({ event: "drive_dispatch", processed: result.processed, synced: result.synced, failed: result.failed }));
    }
  } catch {
    if (running) console.error("同期サーバーに接続できませんでした。次の確認で再試行します。");
  }
  if (running) await setTimeout(30_000, undefined, { signal: controller.signal }).catch(() => {});
}
