// Read-only connection check. Never prints credential values or changes cloud resources.
import nextEnv from "@next/env";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { loadEnvConfig } = nextEnv;
loadEnvConfig(projectRoot, true, { info() {}, error() {} });

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
const databaseId = process.env.CLOUDFLARE_D1_DATABASE_ID?.trim();
const workerAddress = process.env.ODDSHOT_D1_WORKER_URL?.trim();
const workerToken = process.env.ODDSHOT_D1_WORKER_TOKEN?.trim();

async function checkWorker() {
  if (!workerAddress || !workerToken) throw new Error("Worker の接続先 URL と認証トークンを設定してください。");
  let base;
  try {
    base = new URL(workerAddress);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error();
  } catch { throw new Error("ODDSHOT_D1_WORKER_URL の形式を確認してください。"); }
  const endpoint = `${base.toString().replace(/\/$/, "")}/health`;
  let response;
  try {
    response = await fetch(endpoint, {
      headers: { Authorization: `Bearer ${workerToken}` },
      cache: "no-store", redirect: "error", signal: AbortSignal.timeout(20_000),
    });
  } catch { throw new Error("Cloudflare の保存先に接続できませんでした。"); }
  if (!response.ok) throw new Error(`Worker の応答は HTTP ${response.status} でした。接続設定を確認してください。`);
  const body = await response.json().catch(() => null);
  if (body?.ok !== true) throw new Error("Worker と D1 の接続を確認できませんでした。");
  console.log("Cloudflare Worker の認証と D1 への接続を確認しました。データ変更はしていません。");
}

async function request(endpoint) {
  let response;
  try {
    response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database${endpoint}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Cloudflare に接続できませんでした。ネットワークを確認してください。");
  }
  if (!response.ok) {
    throw new Error(`Cloudflare の応答は HTTP ${response.status} でした。接続設定と D1 のアクセス権限を確認してください。`);
  }
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error("Cloudflare の応答を読み取れませんでした。");
  }
  if (body.success !== true || body.result == null) {
    throw new Error("Cloudflare が接続確認に成功しませんでした。D1 のアクセス権限を確認してください。");
  }
  return body.result;
}

try {
  if (workerAddress || workerToken) {
    await checkWorker();
  } else {
  const missing = [
    ["CLOUDFLARE_ACCOUNT_ID", accountId],
    ["CLOUDFLARE_API_TOKEN", token],
  ].filter(([, value]) => !value).map(([name]) => name);
  if (missing.length) throw new Error(`.env.local の未設定項目: ${missing.join(", ")}`);
  if (!/^[a-f0-9]{32}$/i.test(accountId)) throw new Error("CLOUDFLARE_ACCOUNT_ID の形式を確認してください。");

  if (databaseId) {
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(databaseId)) {
      throw new Error("CLOUDFLARE_D1_DATABASE_ID の形式を確認してください。");
    }
    const database = await request(`/${databaseId}`);
    if (database.uuid !== databaseId) throw new Error("指定した D1 データベースを確認できませんでした。");
    console.log("Cloudflare の認証と指定した D1 データベースへのアクセスを確認しました。データ変更はしていません。");
  } else {
    const databases = await request("?page=1&per_page=10");
    if (!Array.isArray(databases)) throw new Error("D1 データベース一覧の応答を確認できませんでした。");
    console.log("Cloudflare の認証と D1 一覧へのアクセスを確認しました。");
    console.log("次に保存先を作成または選択し、CLOUDFLARE_D1_DATABASE_ID を設定してください。データ変更はしていません。");
  }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "接続確認に失敗しました。");
  process.exitCode = 1;
}
