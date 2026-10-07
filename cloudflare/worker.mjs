import { Buffer } from "node:buffer";

const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_VALUE_BYTES = 2_000_000;
const MAX_SQL_BYTES = 100_000;
const MAX_STATEMENTS = 50;
const MAX_PARAMS = 100;
const encoder = new TextEncoder();

class RequestError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function responseJson(body, status = 200, headers = {}) {
  return Response.json(body, { status, headers: {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    ...headers,
  } });
}

function invalid(message = "リクエストの形式を確認してください。") {
  return new RequestError(400, "invalid_request", message);
}

function tooLarge() {
  return new RequestError(413, "too_large", "リクエストが保存可能なサイズを超えています。");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function authenticate(request, env) {
  const expected = env.ODDSHOT_D1_WORKER_TOKEN;
  if (typeof expected !== "string" || !expected.trim() || expected.length > 4096) {
    throw new RequestError(503, "storage_unavailable", "保存先の認証設定を確認してください。");
  }
  const authorization = request.headers.get("Authorization");
  const match = authorization?.length <= 4103 ? /^Bearer ([^\s]+)$/i.exec(authorization) : null;
  if (!match) throw new RequestError(403, "forbidden", "この保存先にはアクセスできません。");
  // Fixed-size digests let the runtime compare different-length tokens safely.
  const [expectedHash, suppliedHash] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(match[1])),
  ]);
  if (!crypto.subtle.timingSafeEqual(expectedHash, suppliedHash)) {
    throw new RequestError(403, "forbidden", "この保存先にはアクセスできません。");
  }
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get("Content-Type") ?? "")) {
    throw new RequestError(415, "invalid_request", "JSON 形式で送信してください。");
  }
  const contentLength = request.headers.get("Content-Length");
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw invalid();
    if (Number(contentLength) > MAX_REQUEST_BYTES) throw tooLarge();
  }
  if (!request.body) throw invalid();
  const reader = request.body.getReader();
  let body = Buffer.allocUnsafe(64 * 1024);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const nextSize = size + value.byteLength;
      if (nextSize > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw tooLarge();
      }
      if (nextSize > body.byteLength) {
        const grown = Buffer.allocUnsafe(Math.min(MAX_REQUEST_BYTES, Math.max(body.byteLength * 2, nextSize)));
        body.copy(grown, 0, 0, size);
        body = grown;
      }
      body.set(value, size);
      size = nextSize;
    }
  } finally {
    reader.releaseLock();
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body.subarray(0, size));
    return JSON.parse(text);
  } catch {
    throw invalid("JSON の内容を確認してください。");
  }
}

function validateSql(value) {
  if (typeof value !== "string" || !value.trim()) throw invalid();
  if (encoder.encode(value).byteLength > MAX_SQL_BYTES) throw tooLarge();
  const sql = value.trim();
  if (!/^(SELECT|INSERT|UPDATE)\b/i.test(sql)) throw invalid("この保存先で許可されていない操作です。");
  let quote = null;
  for (let index = 0; index < sql.length; index++) {
    const char = sql[index];
    if (char === "\0") throw invalid();
    if (quote) {
      if (char === quote) {
        if (sql[index + 1] === quote && quote !== "]") index++;
        else quote = null;
      }
    } else if (char === "'" || char === '"' || char === "`") quote = char;
    else if (char === "[") quote = "]";
    else if ((char === "-" && sql[index + 1] === "-") || (char === "/" && sql[index + 1] === "*")) throw invalid();
    else if (char === ";" && sql.slice(index + 1).trim()) throw invalid("SQL は一文ずつ送信してください。");
  }
  if (quote) throw invalid();
  return sql;
}

function decodeParam(value) {
  if (value === null || (typeof value === "number" && Number.isFinite(value))) return value;
  if (typeof value === "string") {
    if (encoder.encode(value).byteLength > MAX_VALUE_BYTES) throw tooLarge();
    return value;
  }
  if (!isRecord(value) || value.type !== "blob" || typeof value.base64 !== "string"
    || Object.keys(value).length !== 2) throw invalid("保存する値の形式を確認してください。");
  const base64 = value.base64;
  if (base64.length > Math.ceil(MAX_VALUE_BYTES / 3) * 4) throw tooLarge();
  if (base64.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)) throw invalid("画像データの形式を確認してください。");
  const bytes = Buffer.from(base64, "base64");
  if (bytes.byteLength > MAX_VALUE_BYTES) throw tooLarge();
  if (bytes.toString("base64") !== base64) throw invalid("画像データの形式を確認してください。");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function validateStatement(value) {
  if (!isRecord(value) || !Array.isArray(value.params) || value.params.length > MAX_PARAMS
    || !["all", "get", "run"].includes(value.mode)) throw invalid();
  return { sql: validateSql(value.sql), params: value.params.map(decodeParam), mode: value.mode };
}

function encodeValue(value) {
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  let bytes;
  if (value instanceof ArrayBuffer) bytes = Buffer.from(value);
  else if (ArrayBuffer.isView(value)) bytes = Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  else if (Array.isArray(value) && value.every((byte) => Number.isInteger(byte) && byte >= 0 && byte <= 255)) bytes = Buffer.from(value);
  else throw new Error("Unsupported storage result type");
  if (bytes.byteLength > MAX_VALUE_BYTES) throw new Error("Storage result exceeds value limit");
  return { type: "blob", base64: bytes.toString("base64") };
}

function encodeRow(row) {
  if (!isRecord(row)) throw new Error("Invalid storage row");
  return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, encodeValue(value)]));
}

function storageError(error) {
  const message = error instanceof Error ? error.message : "";
  if (/UNIQUE constraint failed|PRIMARY KEY constraint failed|SQLITE_CONSTRAINT_(?:UNIQUE|PRIMARYKEY)/i.test(message)) {
    return responseJson({ error: "同じ識別子のデータがすでに保存されています。", code: "conflict" }, 409);
  }
  if (/FOREIGN KEY constraint failed|CHECK constraint failed|NOT NULL constraint failed|SQLITE_CONSTRAINT/i.test(message)) {
    return responseJson({ error: "保存するデータの整合性を確認してください。", code: "constraint" }, 422);
  }
  // Deliberately omit database errors: D1 may include SQL, parameters, or schema details.
  console.error(JSON.stringify({ event: "oddshot_d1_request_failed", category: "storage" }));
  return responseJson({ error: "保存先への接続に失敗しました。少し待って再度お試しください。", code: "storage_unavailable" }, 503);
}

export default {
  async scheduled(_controller, env, ctx) {
    const callback = env.ODDSHOT_SYNC_CALLBACK_URL;
    const secret = env.ODDSHOT_SYNC_SECRET;
    if (!callback || !secret) return;
    let url;
    try { url = new URL(callback); } catch { return; }
    if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search
      || url.pathname !== "/api/admin/drive/process" || typeof secret !== "string" || secret.trim().length < 32) return;
    ctx.waitUntil((async () => {
      try {
        const response = await fetch(url, { method: "POST", headers: { Authorization: `Bearer ${secret.trim()}` }, redirect: "error", signal: AbortSignal.timeout(290_000) });
        await response.body?.cancel();
        if (!response.ok) console.error(JSON.stringify({ event: "oddshot_drive_dispatch_failed", status: response.status }));
      } catch { console.error(JSON.stringify({ event: "oddshot_drive_dispatch_failed" })); }
    })());
  },
  async fetch(request, env) {
    try {
      await authenticate(request, env);
      const pathname = new URL(request.url).pathname;
      if (pathname !== "/health" && pathname !== "/query") return responseJson({ error: "保存先が見つかりません。", code: "not_found" }, 404);
      const method = pathname === "/health" ? "GET" : "POST";
      if (request.method !== method) return responseJson({ error: "この操作は利用できません。", code: "method_not_allowed" }, 405, { Allow: method });
      if (!env.DB || typeof env.DB.prepare !== "function" || typeof env.DB.batch !== "function") {
        throw new RequestError(503, "storage_unavailable", "保存先の接続設定を確認してください。");
      }
      if (pathname === "/health") {
        const result = await env.DB.prepare("SELECT 1 AS ok").first();
        if (!result || result.ok !== 1) throw new Error("Health check failed");
        return responseJson({ ok: true });
      }
      const input = await readJson(request);
      if (!isRecord(input) || !Array.isArray(input.statements) || input.statements.length < 1 || input.statements.length > MAX_STATEMENTS) throw invalid();
      const statements = input.statements.map(validateStatement);
      // D1 batch is atomic: if one statement fails, all writes in the batch roll back.
      const batch = await env.DB.batch(statements.map(({ sql, params }) => env.DB.prepare(sql).bind(...params)));
      if (!Array.isArray(batch) || batch.length !== statements.length || batch.some((result) => result.success === false)) throw new Error("Storage batch failed");
      const results = batch.map((result, index) => {
        const rows = statements[index].mode === "run" ? [] : (result.results ?? []);
        if (!Array.isArray(rows)) throw new Error("Invalid storage results");
        const selected = statements[index].mode === "get" ? rows.slice(0, 1) : rows;
        return { rows: selected.map(encodeRow), meta: { changes: Number.isSafeInteger(result.meta?.changes) && result.meta.changes >= 0 ? result.meta.changes : 0 } };
      });
      return responseJson({ results });
    } catch (error) {
      if (error instanceof RequestError) return responseJson({ error: error.message, code: error.code }, error.status);
      return storageError(error);
    }
  },
};
