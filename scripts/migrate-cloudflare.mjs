// Explicit, resumable copy into the configured private D1 Worker. No secrets or photo data are logged.
import nextEnv from "@next/env";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
nextEnv.loadEnvConfig(root, true, { info() {}, error() {} });
const copy = process.argv.includes("--copy");
const sourcePath = process.env.ODDSHOT_MIGRATION_SOURCE || path.join(root, "work/oddshot.sqlite");
const tables = [
  { name: "profiles", key: "id", columns: ["id", "nickname", "nickname_key", "color", "created_at"] },
  { name: "scoring_criteria", key: "version", columns: ["id", "version", "criteria_json", "created_at", "is_active"] },
  { name: "photos", key: "id", columns: ["id", "user_id", "title", "image_bytes", "mime_type", "sample_key", "created_at", "sync_status", "sync_updated_at", "request_id", "request_fingerprint", "title_suggestions_json"] },
  { name: "evaluations", key: "id", columns: ["id", "photo_id", "evaluation_json", "created_at", "criteria_version"] },
];

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function wire(value) { return value instanceof Uint8Array ? { type: "blob", base64: Buffer.from(value).toString("base64") } : value; }
function equivalent(local, remote) {
  if (local instanceof Uint8Array) return remote?.type === "blob" && hash(local) === hash(Buffer.from(remote.base64, "base64"));
  return local === remote;
}

async function main() {
  const address = process.env.ODDSHOT_D1_WORKER_URL?.trim();
  const token = process.env.ODDSHOT_D1_WORKER_TOKEN?.trim();
  if (!address || !token) throw new Error("Worker の接続設定が未完了です。");
  const base = new URL(address);
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) throw new Error("Worker URL の形式を確認してください。");
  const endpoint = `${base.toString().replace(/\/$/, "")}/query`;
  async function query(statements) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ statements }), redirect: "error", cache: "no-store", signal: AbortSignal.timeout(30_000),
      });
    } catch { throw new Error("移行先への接続に失敗しました。保存先の切り替えは行っていません。"); }
    if (!response.ok) throw new Error(`移行先が HTTP ${response.status} を返しました。既存データは上書きしていません。`);
    const body = await response.json();
    if (!Array.isArray(body.results) || body.results.length !== statements.length) throw new Error("移行先の応答を確認できませんでした。");
    return body.results;
  }
  let source = new DatabaseSync(sourcePath, { readOnly: true });
  let snapshot;
  try {
    if (copy) {
      const backupDirectory = process.env.ODDSHOT_MIGRATION_BACKUP_DIR || path.join(root, "work/backups");
      mkdirSync(backupDirectory, { recursive: true });
      snapshot = path.join(backupDirectory, `before-d1-${Date.now()}.sqlite`);
      // VACUUM INTO creates a consistent snapshot without altering the original database.
      source.prepare("VACUUM INTO ?").run(snapshot);
      chmodSync(snapshot, 0o600);
      source.close();
      source = new DatabaseSync(snapshot, { readOnly: true });
      console.log("移行前の SQLite バックアップを work/backups に保存しました。");
    }
    if (source.prepare("PRAGMA foreign_key_check").all().length) throw new Error("移行元のデータ関連に不整合があるため、処理を中止しました。");
    const localTables = tables.map(table => ({ ...table, rows: source.prepare(`SELECT ${table.columns.join(", ")} FROM ${table.name}`).all() }));
    let writes = 0;
    for (const table of localTables) {
      const [{ rows: remoteKeys }] = await query([{ sql: `SELECT ${table.key} FROM ${table.name}`, params: [], mode: "all" }]);
      const localKeys = new Set(table.rows.map(row => row[table.key]));
      if (remoteKeys.some(row => !localKeys.has(row[table.key]))) throw new Error(`${table.name}: 移行先に別のデータがあります。上書きを避けるため中止しました。`);
      for (const row of table.rows) {
        const [{ rows: existing }] = await query([{ sql: `SELECT ${table.columns.join(", ")} FROM ${table.name} WHERE ${table.key} = ?`, params: [row[table.key]], mode: "get" }]);
        if (existing.length) {
          if (table.columns.some(column => !equivalent(row[column], existing[0][column]))) throw new Error(`${table.name}: 同じ ID の内容が一致しないため中止しました。既存の行は上書きしていません。`);
          continue;
        }
        if (!copy) throw new Error(`${table.name}: 移行先に不足している行があります。コピーには --copy が必要です。`);
        await query([{ sql: `INSERT INTO ${table.name} (${table.columns.join(", ")}) VALUES (${table.columns.map(() => "?").join(", ")})`, params: table.columns.map(column => wire(row[column])), mode: "run" }]);
        writes++;
      }
    }
    // Re-read every row, including images, after all writes. Compare exact JSON/metadata and binary hashes.
    const counts = {};
    for (const table of localTables) {
      const [{ rows: countRows }] = await query([{ sql: `SELECT COUNT(*) AS count FROM ${table.name}`, params: [], mode: "get" }]);
      if (countRows[0].count !== table.rows.length) throw new Error(`${table.name}: 件数が一致しません。`);
      for (const row of table.rows) {
        const [{ rows }] = await query([{ sql: `SELECT ${table.columns.join(", ")} FROM ${table.name} WHERE ${table.key} = ?`, params: [row[table.key]], mode: "get" }]);
        if (rows.length !== 1 || table.columns.some(column => !equivalent(row[column], rows[0][column]))) throw new Error(`${table.name}: コピー後の内容が一致しません。`);
      }
      counts[table.name] = table.rows.length;
    }
    console.log(JSON.stringify({ verified: true, insertedRows: writes, counts, imageHashes: "matched", evaluationAndCriteriaJson: "matched" }));
    console.log("照合に成功しました。保存先の設定はこのスクリプトでは変更しません。");
  } finally { source.close(); }
}
main().catch(error => {
  console.error(error instanceof Error ? error.message : "移行の確認に失敗しました。");
  process.exitCode = 1;
});
