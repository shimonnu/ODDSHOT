import assert from "node:assert/strict";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createD1Storage, createSqliteStorage, StorageError, storageMode } from "../lib/storage";

test("SQLite batch is atomic and retains binary values", async () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE items (id TEXT PRIMARY KEY, bytes BLOB NOT NULL)");
  const storage = createSqliteStorage(database);
  try {
    await assert.rejects(storage.batch([
      { sql: "INSERT INTO items VALUES (?, ?)", params: ["same", Buffer.from([0, 255, 128])], mode: "run" },
      { sql: "INSERT INTO items VALUES (?, ?)", params: ["same", Buffer.from([3])], mode: "run" },
    ]));
    assert.equal((await storage.get<{ count: number }>("SELECT COUNT(*) AS count FROM items"))?.count, 0);
    await storage.run("INSERT INTO items VALUES (?, ?)", ["one", Buffer.from([0, 255, 128])]);
    const row = await storage.get<{ bytes: Uint8Array }>("SELECT bytes FROM items WHERE id = ?", ["one"]);
    assert.deepEqual(Buffer.from(row!.bytes), Buffer.from([0, 255, 128]));
  } finally { database.close(); }
});

test("D1 adapter sends authenticated batches and round-trips BLOBs using base64", async () => {
  const oldFetch = globalThis.fetch;
  const oldURL = process.env.ODDSHOT_D1_WORKER_URL;
  const oldToken = process.env.ODDSHOT_D1_WORKER_TOKEN;
  process.env.ODDSHOT_D1_WORKER_URL = "https://example-worker.invalid/";
  process.env.ODDSHOT_D1_WORKER_TOKEN = "offline-worker-token";
  try {
    globalThis.fetch = async (url, init) => {
      assert.equal(url, "https://example-worker.invalid/query");
      assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-worker-token");
      assert.equal(init?.cache, "no-store");
      assert.equal(init?.redirect, "error");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.statements.length, 2);
      assert.deepEqual(body.statements[0].params, ["one", { type: "blob", base64: "AP+A" }]);
      assert.ok(body.statements.every((statement: { sql: string }) => !/BEGIN|COMMIT/.test(statement.sql)));
      return Response.json({ results: [
        { rows: [], meta: { changes: 1 } },
        { rows: [{ bytes: { type: "blob", base64: "AP+A" }, label: "一枚", count: 1, empty: null }], meta: { changes: 0 } },
      ] });
    };
    const result = await createD1Storage().batch([
      { sql: "INSERT INTO items VALUES (?, ?)", params: ["one", Buffer.from([0, 255, 128])], mode: "run" },
      { sql: "SELECT * FROM items", mode: "all" },
    ]);
    assert.equal(result[0].meta.changes, 1);
    assert.deepEqual(result[1].rows[0].bytes, Buffer.from([0, 255, 128]));
    assert.equal(result[1].rows[0].label, "一枚");
  } finally {
    globalThis.fetch = oldFetch;
    if (oldURL === undefined) delete process.env.ODDSHOT_D1_WORKER_URL; else process.env.ODDSHOT_D1_WORKER_URL = oldURL;
    if (oldToken === undefined) delete process.env.ODDSHOT_D1_WORKER_TOKEN; else process.env.ODDSHOT_D1_WORKER_TOKEN = oldToken;
  }
});

test("D1 failures and malformed responses are explicit and do not expose private upstream details", async () => {
  const oldFetch = globalThis.fetch;
  const oldURL = process.env.ODDSHOT_D1_WORKER_URL;
  const oldToken = process.env.ODDSHOT_D1_WORKER_TOKEN;
  const oldMode = process.env.ODDSHOT_STORAGE_MODE;
  process.env.ODDSHOT_D1_WORKER_URL = "https://example-worker.invalid";
  process.env.ODDSHOT_D1_WORKER_TOKEN = "offline-worker-token";
  try {
    delete process.env.ODDSHOT_STORAGE_MODE;
    assert.equal(storageMode(), "sqlite");
    process.env.ODDSHOT_STORAGE_MODE = "invalid";
    assert.throws(storageMode, (error: unknown) => error instanceof StorageError && error.code === "configuration");
    delete process.env.ODDSHOT_D1_WORKER_TOKEN;
    assert.throws(createD1Storage, (error: unknown) => error instanceof StorageError && error.code === "configuration");
    process.env.ODDSHOT_D1_WORKER_TOKEN = "offline-worker-token";
    for (const status of [401, 403, 404, 409, 500, 503]) {
      globalThis.fetch = async () => Response.json({ error: "private connection detail" }, { status });
      await assert.rejects(createD1Storage().get("SELECT id FROM profiles"), (error: unknown) => error instanceof StorageError && !error.message.includes("private"));
    }
    for (const payload of [
      { results: [] },
      { results: [{ rows: [], meta: { changes: -1 } }] },
      { results: [{ rows: [{ value: { type: "blob", base64: "invalid!?" } }], meta: { changes: 0 } }] },
      { results: [{ rows: [null], meta: { changes: 0 } }] },
    ]) {
      globalThis.fetch = async () => Response.json(payload);
      await assert.rejects(createD1Storage().get("SELECT id FROM profiles"), (error: unknown) => error instanceof StorageError && error.code === "invalid_response");
    }
    globalThis.fetch = async () => { throw new DOMException("timeout", "TimeoutError"); };
    await assert.rejects(createD1Storage().get("SELECT id FROM profiles"), (error: unknown) => error instanceof StorageError && error.status === 504);
  } finally {
    globalThis.fetch = oldFetch;
    for (const [key, value] of [["ODDSHOT_D1_WORKER_URL", oldURL], ["ODDSHOT_D1_WORKER_TOKEN", oldToken], ["ODDSHOT_STORAGE_MODE", oldMode]]) {
      if (value === undefined) delete process.env[key!]; else process.env[key!] = value;
    }
  }
});
