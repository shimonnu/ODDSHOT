import assert from "node:assert/strict";
import test from "node:test";
import { Buffer } from "node:buffer";
import { timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import worker from "../cloudflare/worker.mjs";

// Node's WebCrypto lacks Cloudflare's documented extension; the native Node
// constant-time implementation gives the same contract for these offline tests.
Object.defineProperty(crypto.subtle, "timingSafeEqual", {
  configurable: true,
  value: (a, b) => timingSafeEqual(Buffer.from(a), Buffer.from(b)),
});

const token = "offline-worker-test-token";

class MockD1 {
  constructor() {
    this.sqlite = new DatabaseSync(":memory:");
    this.sqlite.exec("PRAGMA foreign_keys=ON; CREATE TABLE owners(id TEXT PRIMARY KEY); INSERT INTO owners VALUES ('owner'); CREATE TABLE items(id TEXT PRIMARY KEY, value BLOB, label TEXT, owner_id TEXT REFERENCES owners(id));");
    this.prepared = [];
    this.batchCalls = 0;
  }
  prepare(sql) {
    this.prepared.push(sql);
    const sqlite = this.sqlite;
    const bound = { sql, params: [] };
    return {
      ...bound,
      bind(...params) { return { sql, params }; },
      async first() { return sqlite.prepare(sql).get() ?? null; },
    };
  }
  async batch(statements) {
    this.batchCalls++;
    this.sqlite.exec("BEGIN");
    try {
      const results = statements.map(({ sql, params }) => {
        const bound = params.map((value) => value instanceof ArrayBuffer ? Buffer.from(value) : value);
        const statement = this.sqlite.prepare(sql);
        const results = statement.all(...bound);
        const changes = /^\s*(?:INSERT|UPDATE)\b/i.test(sql) ? this.sqlite.prepare("SELECT changes() AS changes").get().changes : 0;
        return { success: true, results, meta: { changes } };
      });
      this.sqlite.exec("COMMIT");
      return results;
    } catch (error) {
      this.sqlite.exec("ROLLBACK");
      throw error;
    }
  }
  close() { this.sqlite.close(); }
}

function env(database = new MockD1()) {
  return { DB: database, ODDSHOT_D1_WORKER_TOKEN: token };
}

function request(statements, options = {}) {
  return new Request(`https://storage.example${options.path ?? "/query"}`, {
    method: options.method ?? "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, ...options.headers },
    body: JSON.stringify({ statements }),
  });
}

function select(sql = "SELECT 1 AS ok", params = [], mode = "all") {
  return { sql, params, mode };
}

async function assertRejected(input, environment, status = 400, code = "invalid_request") {
  const before = environment.DB.prepared.length;
  const response = await worker.fetch(input, environment);
  assert.equal(response.status, status);
  assert.equal((await response.json()).code, code);
  assert.equal(environment.DB.prepared.length, before, "validation finishes before preparing SQL");
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
}

test("authentication is required for health, queries and unknown paths", async () => {
  const environment = env();
  try {
    await assertRejected(new Request("https://storage.example/health"), environment, 403, "forbidden");
    await assertRejected(new Request("https://storage.example/health", { headers: { Authorization: "Bearer wrong-token" } }), environment, 403, "forbidden");
    await assertRejected(request([select()], { headers: { Authorization: "Basic offline" } }), environment, 403, "forbidden");
    await assertRejected(new Request("https://storage.example/unknown"), environment, 403, "forbidden");
    for (const value of [undefined, "", "   "]) {
      const response = await worker.fetch(new Request("https://storage.example/health"), { ...environment, ODDSHOT_D1_WORKER_TOKEN: value });
      assert.equal(response.status, 503);
    }
    const healthy = await worker.fetch(new Request("https://storage.example/health", { headers: { Authorization: `Bearer ${token}` } }), environment);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { ok: true });
    assert.deepEqual(environment.DB.prepared, ["SELECT 1 AS ok"]);
  } finally { environment.DB.close(); }
});

test("route methods and configuration fail closed without public CORS", async () => {
  const environment = env();
  try {
    const preflight = await worker.fetch(new Request("https://storage.example/query", { method: "OPTIONS", headers: { Authorization: `Bearer ${token}`, Origin: "https://public.example" } }), environment);
    assert.equal(preflight.status, 405);
    assert.equal(preflight.headers.get("Access-Control-Allow-Origin"), null);
    assert.equal(preflight.headers.get("Allow"), "POST");
    const unknown = await worker.fetch(new Request("https://storage.example/unknown", { headers: { Authorization: `Bearer ${token}` } }), environment);
    assert.equal(unknown.status, 404);
    const missingBinding = await worker.fetch(request([select()]), { ODDSHOT_D1_WORKER_TOKEN: token });
    assert.equal(missingBinding.status, 503);
    assert.equal(environment.DB.batchCalls, 0);
  } finally { environment.DB.close(); }
});

test("one atomic D1 batch returns ordered modes and round-trips photo BLOBs", async () => {
  const environment = env();
  const image = Buffer.from([0, 1, 42, 128, 255]);
  try {
    const response = await worker.fetch(request([
      { sql: "INSERT INTO items(id,value,label,owner_id) VALUES (?,?,?,?)", params: ["photo", { type: "blob", base64: image.toString("base64") }, "写真", "owner"], mode: "run" },
      select("SELECT id,value,label FROM items WHERE id = ?", ["photo"], "get"),
      { sql: "UPDATE items SET label = ? WHERE id = ?", params: ["更新済み", "photo"], mode: "run" },
      select("SELECT label,NULL AS empty,1.5 AS score FROM items"),
    ]), environment);
    assert.equal(response.status, 200);
    assert.equal(environment.DB.batchCalls, 1);
    assert.deepEqual(await response.json(), { results: [
      { rows: [], meta: { changes: 1 } },
      { rows: [{ id: "photo", value: { type: "blob", base64: image.toString("base64") }, label: "写真" }], meta: { changes: 0 } },
      { rows: [], meta: { changes: 1 } },
      { rows: [{ label: "更新済み", empty: null, score: 1.5 }], meta: { changes: 0 } },
    ] });
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.equal(response.headers.get("Access-Control-Allow-Origin"), null);
    assert.ok(Buffer.from(environment.DB.sqlite.prepare("SELECT value FROM items").get().value).equals(image));
  } finally { environment.DB.close(); }
});

test("result serialization supports ArrayBuffer, Uint8Array offsets and numeric arrays", async () => {
  const bytes = Uint8Array.from([99, 10, 20, 88]);
  const database = {
    prepare(sql) { return { bind() { return { sql }; } }; },
    async batch() { return [{ success: true, results: [{ arrayBuffer: Uint8Array.from([1, 2]).buffer, view: bytes.subarray(1, 3), array: [3, 4], zero: [] }, { array: [5] }], meta: { changes: 0 } }]; },
  };
  const response = await worker.fetch(request([select("SELECT value FROM items", [], "get")]), env(database));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).results[0].rows, [{
    arrayBuffer: { type: "blob", base64: "AQI=" }, view: { type: "blob", base64: "ChQ=" },
    array: { type: "blob", base64: "AwQ=" }, zero: { type: "blob", base64: "" },
  }]);
});

test("batch failure rolls back all writes and returns safe conflict details", async () => {
  const environment = env();
  try {
    const response = await worker.fetch(request([
      { sql: "INSERT INTO items(id,label) VALUES (?,?)", params: ["duplicate", "private input"], mode: "run" },
      { sql: "INSERT INTO items(id,label) VALUES (?,?)", params: ["duplicate", "another private input"], mode: "run" },
    ]), environment);
    assert.equal(response.status, 409);
    const text = await response.text();
    assert.equal(JSON.parse(text).code, "conflict");
    assert.ok(!text.includes("INSERT") && !text.includes("items") && !text.includes("private input"));
    assert.equal(environment.DB.sqlite.prepare("SELECT COUNT(*) AS count FROM items").get().count, 0);
    const foreign = await worker.fetch(request([{ sql: "INSERT INTO items(id,owner_id) VALUES (?,?)", params: ["orphan", "missing"], mode: "run" }]), environment);
    assert.equal(foreign.status, 422);
    assert.equal((await foreign.json()).code, "constraint");
  } finally { environment.DB.close(); }
});

test("unsafe SQL, malformed JSON and invalid values never reach D1", async () => {
  const environment = env();
  try {
    for (const sql of ["DROP TABLE items", "DELETE FROM items", "PRAGMA foreign_keys=OFF", "BEGIN", "CREATE TABLE x(id)", "SELECT 1; DELETE FROM items", "SELECT 1; SELECT 2", "SELECT 1 -- comment", "SELECT 1 /* comment */", "SELECT 'unclosed", "SELECT 1\0", "WITH x AS (SELECT 1) SELECT * FROM x"]) await assertRejected(request([select(sql)]), environment);
    for (const value of [true, {}, [], { type: "blob", base64: "@bad" }, { type: "blob", base64: "Zg=" }, { type: "blob", base64: "Zh==" }, { type: "blob", base64: "Zg==", extra: true }]) await assertRejected(request([select("SELECT ? AS v", [value])]), environment);
    await assertRejected(request([]), environment);
    await assertRejected(request(Array.from({ length: 51 }, () => select())), environment);
    await assertRejected(request([select("SELECT ? AS v", Array(101).fill(1))]), environment);
    await assertRejected(request([select("SELECT 1", [], "unknown")]), environment);
    await assertRejected(new Request("https://storage.example/query", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: "{broken" }), environment);
    await assertRejected(request([select()], { headers: { "Content-Type": "text/plain" } }), environment, 415);
    await assertRejected(new Request("https://storage.example/query", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: '{"statements":[{"sql":"SELECT ? AS v","params":[1e999],"mode":"all"}]}' }), environment);
    const quoted = await worker.fetch(request([select("SELECT 'literal; -- value' AS label;")]), environment);
    assert.equal(quoted.status, 200);
  } finally { environment.DB.close(); }
});

test("request, SQL, string and BLOB byte limits are checked before D1", async () => {
  const environment = env();
  try {
    await assertRejected(request([select()], { headers: { "Content-Length": String(8 * 1024 * 1024 + 1) } }), environment, 413, "too_large");
    await assertRejected(request([select("SELECT 1" + " ".repeat(100_001))]), environment, 413, "too_large");
    await assertRejected(request([select("SELECT ? AS v", ["あ".repeat(666_667)])]), environment, 413, "too_large");
    await assertRejected(request([select("SELECT ? AS v", [{ type: "blob", base64: Buffer.alloc(2_000_001).toString("base64") }])]), environment, 413, "too_large");
    let chunks = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) { controller.enqueue(new Uint8Array(64 * 1024)); if (++chunks > 130) controller.close(); },
      cancel() { cancelled = true; },
    });
    const streaming = new Request("https://storage.example/query", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body, duplex: "half" });
    await assertRejected(streaming, environment, 413, "too_large");
    assert.equal(cancelled, true);
    const boundary = await worker.fetch(request([select("SELECT 1 AS ok" + " ".repeat(100_000 - "SELECT 1 AS ok".length))]), environment);
    assert.equal(boundary.status, 200);
    const fifty = await worker.fetch(request(Array.from({ length: 50 }, () => select())), environment);
    assert.equal(fifty.status, 200);
    assert.equal((await fifty.json()).results.length, 50);
  } finally { environment.DB.close(); }
});

test("database exceptions do not disclose SQL, values or secrets", async () => {
  const database = {
    prepare(sql) { return { bind() { return { sql }; } }; },
    async batch() { throw new Error("SELECT secret FROM private_items; private-input offline-worker-test-token"); },
  };
  const response = await worker.fetch(request([select()]), env(database));
  assert.equal(response.status, 503);
  const body = await response.text();
  assert.equal(JSON.parse(body).code, "storage_unavailable");
  assert.ok(!body.includes("SELECT") && !body.includes("private") && !body.includes(token));
  assert.equal(response.headers.get("Cache-Control"), "no-store");
});

test("Drive cron dispatch is disabled without an explicit HTTPS callback and secret", async () => {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new Error("Must not dispatch"); };
  try {
    for (const settings of [{}, { ODDSHOT_SYNC_CALLBACK_URL: "http://127.0.0.1/api/admin/drive/process", ODDSHOT_SYNC_SECRET: "x".repeat(40) }, { ODDSHOT_SYNC_CALLBACK_URL: "https://app.example/wrong", ODDSHOT_SYNC_SECRET: "x".repeat(40) }]) {
      await worker.scheduled({}, settings, { waitUntil() { throw new Error("Must not schedule"); } });
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("Drive cron dispatch sends the scheduler credential only to the configured endpoint", async () => {
  const original = globalThis.fetch;
  const waits = [];
  const secret = "offline-scheduler-test-secret-0123456789";
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(String(url), "https://app.example/api/admin/drive/process");
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${secret}`);
    assert.equal(options.redirect, "error");
    return new Response("{}", { status: 200 });
  };
  try {
    await worker.scheduled({}, { ODDSHOT_SYNC_CALLBACK_URL: "https://app.example/api/admin/drive/process", ODDSHOT_SYNC_SECRET: secret }, { waitUntil(task) { waits.push(task); } });
    await Promise.all(waits);
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});
