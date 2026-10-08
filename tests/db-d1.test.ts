import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createPhoto, createProfile, generatePhotoTitles, getPhotoImage, getState, updatePhotoTitle, updateSyncStatus } from "../lib/db";
import { decisionsScoringCriteria, demoEvaluation } from "../lib/demo";
import { StorageError } from "../lib/storage";

const originalDirectory = process.cwd();
const fixture = mkdtempSync(path.join(tmpdir(), "oddshot-d1-fixture-"));
mkdirSync(path.join(fixture, "public/images"), { recursive: true });
for (const name of ["forest", "sky"]) copyFileSync(path.join(originalDirectory, `public/images/${name}.jpg`), path.join(fixture, `public/images/${name}.jpg`));
process.chdir(fixture);
const remote = new DatabaseSync(":memory:");
remote.exec(`
  PRAGMA foreign_keys = ON;
  CREATE TABLE profiles (id TEXT PRIMARY KEY, nickname TEXT NOT NULL, nickname_key TEXT UNIQUE NOT NULL, color TEXT NOT NULL, created_at TEXT NOT NULL);
  CREATE TABLE photos (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(id), title TEXT NOT NULL, image_bytes BLOB, mime_type TEXT NOT NULL, sample_key TEXT, created_at TEXT NOT NULL, sync_status TEXT NOT NULL, sync_updated_at TEXT, request_id TEXT, request_fingerprint TEXT, title_suggestions_json TEXT);
  CREATE UNIQUE INDEX photos_request_id ON photos(request_id) WHERE request_id IS NOT NULL;
  CREATE TABLE evaluations (id TEXT PRIMARY KEY, photo_id TEXT UNIQUE NOT NULL REFERENCES photos(id), evaluation_json TEXT NOT NULL, created_at TEXT NOT NULL, criteria_version TEXT NOT NULL);
  CREATE TABLE scoring_criteria (id TEXT NOT NULL, version TEXT PRIMARY KEY, criteria_json TEXT NOT NULL, created_at TEXT NOT NULL, is_active INTEGER NOT NULL);
`);
const createdAt = "2026-10-01T00:00:00.000Z";
remote.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run("migrated-user", "移行した参加者", "移行した参加者", "#D4E97D", createdAt);
remote.prepare("INSERT INTO scoring_criteria VALUES (?, ?, ?, ?, 1)").run(decisionsScoringCriteria.id, decisionsScoringCriteria.version, JSON.stringify(decisionsScoringCriteria), createdAt);
const image = readFileSync(path.join(fixture, "public/images/forest.jpg"));
const migratedEvaluation = demoEvaluation(image, "forest", createdAt);
remote.prepare("INSERT INTO photos (id,user_id,title,image_bytes,mime_type,sample_key,created_at,sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("migrated-photo", "migrated-user", "移行した一枚", image, "image/jpeg", "forest", createdAt, "synced");
remote.prepare("INSERT INTO evaluations VALUES (?, ?, ?, ?, ?)").run(migratedEvaluation.id, "migrated-photo", JSON.stringify(migratedEvaluation), createdAt, "demo-v1");

type WireStatement = { sql: string; params: (string | number | null | { type: "blob"; base64: string })[]; mode: "all" | "get" | "run" };
const batches: WireStatement[][] = [];
let failEvaluation = false;
let beforeBatch: ((statements: WireStatement[]) => Promise<void>) | undefined;
const oldFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(["ODDSHOT_STORAGE_MODE", "ODDSHOT_D1_WORKER_URL", "ODDSHOT_D1_WORKER_TOKEN", "ODDSHOT_SCORING_MODE"].map(key => [key, process.env[key]]));
process.env.ODDSHOT_STORAGE_MODE = "d1";
process.env.ODDSHOT_D1_WORKER_URL = "https://offline-d1.invalid";
process.env.ODDSHOT_D1_WORKER_TOKEN = "offline-d1-token";
process.env.ODDSHOT_SCORING_MODE = "demo";
globalThis.fetch = async (url, init) => {
  assert.equal(url, "https://offline-d1.invalid/query", "this test must never call an external AI service");
  assert.equal((init?.headers as Record<string, string>).Authorization, "Bearer offline-d1-token");
  const { statements } = JSON.parse(String(init?.body)) as { statements: WireStatement[] };
  batches.push(statements);
  assert.ok(statements.every(statement => !/^(?:CREATE|ALTER|PRAGMA|BEGIN|COMMIT)/i.test(statement.sql)), "D1 runtime must not bootstrap schema or send transaction controls");
  await beforeBatch?.(statements);
  remote.exec("BEGIN IMMEDIATE");
  try {
    const results = statements.map(statement => {
      if (failEvaluation && /^INSERT INTO evaluations/.test(statement.sql)) throw new Error("offline evaluation failure");
      const params = statement.params.map(value => typeof value === "object" && value !== null ? Buffer.from(value.base64, "base64") : value);
      const query = remote.prepare(statement.sql);
      if (statement.mode === "run") return { rows: [], meta: { changes: Number(query.run(...params).changes) } };
      const rows = statement.mode === "get" ? [query.get(...params)].filter(Boolean) : query.all(...params);
      return {
        rows: rows.map(row => Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, value instanceof Uint8Array ? { type: "blob", base64: Buffer.from(value).toString("base64") } : value]))),
        meta: { changes: 0 },
      };
    });
    remote.exec("COMMIT");
    return Response.json({ results });
  } catch {
    remote.exec("ROLLBACK");
    return Response.json({ error: "保存できませんでした。", code: "storage_unavailable" }, { status: 503 });
  }
};
after(() => {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  remote.close();
  process.chdir(originalDirectory);
  rmSync(fixture, { recursive: true, force: true });
});

test("D1 metadata, photo BLOB, profile creation and atomic photo/evaluation save work without local SQLite", async () => {
  const before = await getState();
  assert.equal(before.photos[0].title, "移行した一枚");
  assert.equal(before.photos[0].evaluation.criteriaVersion, "demo-v1");
  assert.ok(batches[0].every(statement => !statement.sql.includes("image_bytes")), "state reads must not transfer photo BLOBs");
  assert.deepEqual((await getPhotoImage("migrated-photo")).bytes, image);
  const user = await createProfile("D1保存の検証");
  await assert.rejects(createProfile("D1保存の検証"), /登録済み/);
  const input = { userId: user.id, title: "", image: "", sampleKey: "forest", requestId: "d1-photo-retry" };
  const [photo, duplicate] = await Promise.all([createPhoto(input), createPhoto(input)]);
  assert.equal(photo.id, duplicate.id);
  assert.equal(photo.titleSuggestions?.source, "demo");
  assert.equal(photo.evaluation.rank, "S");
  assert.equal((await createPhoto(input)).id, photo.id);
  await assert.rejects(createPhoto({ ...input, title: "別の内容" }), /別の写真/);
  const after = await getState();
  assert.equal(after.photos.length, before.photos.length + 1);
  assert.equal(after.ranking.find(entry => entry.id === user.id)?.highCount, 1);
  const save = batches.find(statements => statements.some(statement => /^INSERT INTO photos/.test(statement.sql)));
  assert.equal(save?.length, 2, "photo and evaluation writes must be one atomic Worker batch");
  assert.ok(save![0].params.some(param => typeof param === "object" && param?.type === "blob"));
  assert.equal(existsSync(path.join(fixture, "work/oddshot.sqlite")), false, "D1 mode must never silently create or fall back to local SQLite");
  assert.equal((globalThis as { oddshotDatabase?: DatabaseSync }).oddshotDatabase, undefined);
  const edited = await updatePhotoTitle(photo.id, user.id, "D1で編集した名前");
  assert.equal(edited.title, "D1で編集した名前");
  assert.equal((await generatePhotoTitles(photo.id, user.id)).title, edited.title);
  assert.equal((await updateSyncStatus(photo.id, "synced")).syncStatus, "synced");
  assert.deepEqual((await getPhotoImage(photo.id)).bytes, image);
});

test("D1 batch failure rolls back both photo and evaluation writes", async () => {
  const before = await getState();
  failEvaluation = true;
  try {
    await assert.rejects(createPhoto({ userId: "migrated-user", title: "ロールバック検証", image: "", sampleKey: "forest", requestId: "d1-rollback-request" }), (error: unknown) => error instanceof StorageError && error.status === 503);
  } finally { failEvaluation = false; }
  const after = await getState();
  assert.equal(after.photos.length, before.photos.length);
  assert.equal((remote.prepare("SELECT COUNT(*) AS count FROM photos WHERE request_id = ?").get("d1-rollback-request") as { count: number }).count, 0);
  assert.equal(existsSync(path.join(fixture, "work/oddshot.sqlite")), false);
});

test("competing request IDs from separate process maps still persist a single photo and evaluation", async () => {
  const before = await getState();
  let reads = 0;
  let entered: () => void = () => {};
  let release: () => void = () => {};
  const firstEntered = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  beforeBatch = async statements => {
    if (statements.length === 1 && statements[0].sql.startsWith("SELECT criteria_json")) {
      reads++;
      if (reads === 1) entered();
      if (reads === 2) release();
      await wait;
    }
  };
  try {
    const input = { userId: "migrated-user", title: "同時保存の検証", image: "", sampleKey: "sky", requestId: "d1-competing-request" };
    const first = createPhoto(input);
    await firstEntered;
    // Another app instance has its own in-memory map but shares D1's unique index.
    (globalThis as { oddshotInFlight?: Map<string, unknown> }).oddshotInFlight?.clear();
    const second = createPhoto(input);
    const [a, b] = await Promise.all([first, second]);
    assert.equal(a.id, b.id);
    assert.equal((await getState()).photos.length, before.photos.length + 1);
    assert.equal((remote.prepare("SELECT COUNT(*) AS count FROM evaluations WHERE photo_id = ?").get(a.id) as { count: number }).count, 1);
  } finally { beforeBatch = undefined; }
});

test("missing D1 setup and missing active criteria fail without SQLite fallback", async () => {
  delete process.env.ODDSHOT_D1_WORKER_TOKEN;
  await assert.rejects(getState(), (error: unknown) => error instanceof StorageError && error.code === "configuration");
  process.env.ODDSHOT_D1_WORKER_TOKEN = "offline-d1-token";
  remote.exec("UPDATE scoring_criteria SET is_active = 0");
  try { await assert.rejects(getState(), /採点基準.*準備/); }
  finally { remote.exec("UPDATE scoring_criteria SET is_active = 1"); }
  assert.equal(existsSync(path.join(fixture, "work/oddshot.sqlite")), false);
});
