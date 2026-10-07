import type { DatabaseSync } from "node:sqlite";

export type SqlValue = string | number | null | Uint8Array;
export type StorageStatement = { sql: string; params?: SqlValue[]; mode: "all" | "get" | "run" };
export type StorageResult = { rows: Record<string, unknown>[]; meta: { changes: number } };
export interface Storage {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  get<T>(sql: string, params?: SqlValue[]): Promise<T | undefined>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  batch(statements: StorageStatement[]): Promise<StorageResult[]>;
}

export class StorageError extends Error {
  constructor(message: string, public readonly status = 503, public readonly code: "configuration" | "connection" | "timeout" | "query" | "invalid_response" | "conflict" = "connection") {
    super(message);
    this.name = "StorageError";
  }
}

export function storageMode(): "sqlite" | "d1" {
  const mode = process.env.ODDSHOT_STORAGE_MODE ?? "sqlite";
  if (mode !== "sqlite" && mode !== "d1") throw new StorageError("保存先の設定を確認してください。", 503, "configuration");
  return mode;
}

export function createSqliteStorage(database: DatabaseSync): Storage {
  const execute = (statement: StorageStatement): StorageResult => {
    const query = database.prepare(statement.sql);
    const params = statement.params ?? [];
    if (statement.mode === "run") return { rows: [], meta: { changes: Number(query.run(...params).changes) } };
    const rows = statement.mode === "all" ? query.all(...params) : [query.get(...params)].filter(row => row !== undefined);
    return { rows: rows as Record<string, unknown>[], meta: { changes: 0 } };
  };
  return {
    async all<T>(sql: string, params: SqlValue[] = []) { return execute({ sql, params, mode: "all" }).rows as T[]; },
    async get<T>(sql: string, params: SqlValue[] = []) { return execute({ sql, params, mode: "get" }).rows[0] as T | undefined; },
    async run(sql: string, params: SqlValue[] = []) { return execute({ sql, params, mode: "run" }).meta; },
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const results = statements.map(execute);
        database.exec("COMMIT");
        return results;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

type BlobValue = { type: "blob"; base64: string };
type WireValue = string | number | null | BlobValue;
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function malformed(): StorageError { return new StorageError("保存先からの応答を確認できませんでした。もう一度お試しください。", 502, "invalid_response"); }

function encode(value: SqlValue): WireValue {
  if (value instanceof Uint8Array) return { type: "blob", base64: Buffer.from(value).toString("base64") };
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  throw new StorageError("保存内容を確認してください。", 400, "query");
}

function decode(value: unknown): SqlValue {
  if (value === null || typeof value === "string" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (isRecord(value) && value.type === "blob" && typeof value.base64 === "string" && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.base64)) {
    return Buffer.from(value.base64, "base64");
  }
  throw malformed();
}

export function createD1Storage(): Storage {
  const address = process.env.ODDSHOT_D1_WORKER_URL?.trim();
  const token = process.env.ODDSHOT_D1_WORKER_TOKEN?.trim();
  if (!address || !token) throw new StorageError("Cloudflare の保存先設定がまだ完了していません。", 503, "configuration");
  let url: URL;
  try {
    url = new URL(address);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { throw new StorageError("Cloudflare の保存先URLを確認してください。", 503, "configuration"); }
  const endpoint = `${url.toString().replace(/\/$/, "")}/query`;
  const batch = async (statements: StorageStatement[]): Promise<StorageResult[]> => {
    if (!statements.length || statements.length > 50) throw new StorageError("保存内容を確認してください。", 400, "query");
    const body = { statements: statements.map(statement => ({ sql: statement.sql, mode: statement.mode, params: (statement.params ?? []).map(encode) })) };
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST", cache: "no-store", redirect: "error",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
      });
    } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new StorageError("保存先の応答に時間がかかっています。もう一度お試しください。", 504, "timeout");
      throw new StorageError("Cloudflare の保存先に接続できませんでした。もう一度お試しください。", 503, "connection");
    }
    if (!response.ok) {
      if ([401, 403].includes(response.status)) throw new StorageError("Cloudflare の保存先の接続設定を確認してください。", 503, "configuration");
      if (response.status === 409) throw new StorageError("保存内容がすでに登録されています。", 409, "conflict");
      throw new StorageError("Cloudflare への保存処理を完了できませんでした。もう一度お試しください。", 503, "query");
    }
    let payload: unknown;
    try { payload = await response.json(); } catch (error) {
      if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) throw new StorageError("保存先の応答に時間がかかっています。もう一度お試しください。", 504, "timeout");
      throw malformed();
    }
    if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length !== statements.length) throw malformed();
    return payload.results.map(result => {
      if (!isRecord(result) || !Array.isArray(result.rows) || !isRecord(result.meta) || typeof result.meta.changes !== "number" || !Number.isSafeInteger(result.meta.changes) || result.meta.changes < 0) throw malformed();
      return {
        rows: result.rows.map(row => {
          if (!isRecord(row)) throw malformed();
          return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, decode(value)]));
        }),
        meta: { changes: result.meta.changes },
      };
    });
  };
  return {
    async all<T>(sql: string, params: SqlValue[] = []) { return (await batch([{ sql, params, mode: "all" }]))[0].rows as T[]; },
    async get<T>(sql: string, params: SqlValue[] = []) { return (await batch([{ sql, params, mode: "get" }]))[0].rows[0] as T | undefined; },
    async run(sql: string, params: SqlValue[] = []) { return (await batch([{ sql, params, mode: "run" }]))[0].meta; },
    batch,
  };
}
