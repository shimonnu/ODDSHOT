import assert from "node:assert/strict";
import { after, test } from "node:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  assignDriveFileIds, claimAppSetting, claimDriveJob, compareAndSetAppSetting, completeDriveJob, createPhoto, enqueueAllDrivePhotos,
  enqueueDrivePhoto, failDriveJob, generatePhotoTitles, getAppSetting, getDrivePhotoPayload,
  getState, setAppSettings, updatePhotoTitle, updateSyncStatus,
} from "../lib/db";
import { decisionsScoringCriteria, demoEvaluation } from "../lib/demo";
import { createAdminSessionCookie, createDriveOAuthAttempt, finishDriveOAuth } from "../lib/drive-auth";
import { processDriveJobs } from "../lib/drive-sync";

const originalDirectory = process.cwd();
const fixture = mkdtempSync(path.join(tmpdir(), "oddshot-drive-jobs-"));
mkdirSync(path.join(fixture, "public/images"), { recursive: true });
for (const name of ["forest", "sky"]) copyFileSync(path.join(originalDirectory, `public/images/${name}.jpg`), path.join(fixture, `public/images/${name}.jpg`));
const database = new DatabaseSync(":memory:");
database.exec("PRAGMA foreign_keys = ON");
for (const name of ["0001_initial.sql", "0002_google_drive.sql"]) database.exec(readFileSync(path.join(originalDirectory, "cloudflare/migrations", name), "utf8"));
// A second application of the additive migration must preserve existing rows.
database.exec(readFileSync(path.join(originalDirectory, "cloudflare/migrations/0002_google_drive.sql"), "utf8"));
const createdAt = "2026-10-01T00:00:00.000Z";
const bytes = readFileSync(path.join(fixture, "public/images/forest.jpg"));
database.prepare("INSERT INTO profiles VALUES (?, ?, ?, ?, ?)").run("owner", "保存の参加者", "保存の参加者", "#D4E97D", createdAt);
database.prepare("INSERT INTO scoring_criteria VALUES (?, ?, ?, ?, 1)").run(decisionsScoringCriteria.id, decisionsScoringCriteria.version, JSON.stringify(decisionsScoringCriteria), createdAt);
const evaluation = demoEvaluation(bytes, "forest", createdAt);
database.prepare("INSERT INTO photos (id,user_id,title,image_bytes,mime_type,sample_key,created_at,sync_status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("legacy-photo", "owner", "以前の写真", bytes, "image/jpeg", "forest", createdAt, "synced");
database.prepare("INSERT INTO evaluations VALUES (?, ?, ?, ?, ?)").run(evaluation.id, "legacy-photo", JSON.stringify(evaluation), createdAt, "demo-v1");
const savedEnv = Object.fromEntries(["ODDSHOT_STORAGE_MODE", "ODDSHOT_D1_WORKER_URL", "ODDSHOT_D1_WORKER_TOKEN", "ODDSHOT_DRIVE_MODE", "ODDSHOT_SCORING_MODE", "GOOGLE_REFRESH_TOKEN", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_REDIRECT_URI", "ODDSHOT_ADMIN_SECRET", "ODDSHOT_GOOGLE_CREDENTIALS_KEY"].map(key => [key, process.env[key]]));
process.chdir(fixture);
process.env.ODDSHOT_STORAGE_MODE = "d1";
process.env.ODDSHOT_D1_WORKER_URL = "https://offline-drive-d1.invalid";
process.env.ODDSHOT_D1_WORKER_TOKEN = "offline-storage-token";
process.env.ODDSHOT_DRIVE_MODE = "google";
process.env.ODDSHOT_SCORING_MODE = "demo";
delete process.env.GOOGLE_REFRESH_TOKEN;
const oldFetch = globalThis.fetch;
type WireStatement = { sql: string; params: (string | number | null | { type: "blob"; base64: string })[]; mode: "all" | "get" | "run" };
let failJobInsert = false;
const batches: WireStatement[][] = [];
let googleHandler: ((address: string, init: RequestInit) => Promise<Response>) | undefined;
globalThis.fetch = async (address, init = {}) => {
  if (String(address) !== "https://offline-drive-d1.invalid/query" && googleHandler) return googleHandler(String(address), init);
  assert.equal(address, "https://offline-drive-d1.invalid/query", "no real Google or AI service is contacted");
  const { statements } = JSON.parse(String(init?.body)) as { statements: WireStatement[] };
  batches.push(statements);
  assert.ok(statements.length <= 50);
  assert.ok(statements.every(statement => /^(SELECT|INSERT|UPDATE)\b/u.test(statement.sql)), "D1 runtime never migrates the schema or sends transaction commands");
  database.exec("BEGIN IMMEDIATE");
  try {
    const results = statements.map(statement => {
      if (failJobInsert && statement.sql.startsWith("INSERT INTO drive_sync_jobs")) throw new Error("offline job write failure");
      const params = statement.params.map(value => value && typeof value === "object" ? Buffer.from(value.base64, "base64") : value);
      const query = database.prepare(statement.sql);
      if (statement.mode === "run") return { rows: [], meta: { changes: Number(query.run(...params).changes) } };
      const rows = statement.mode === "get" ? [query.get(...params)].filter(Boolean) : query.all(...params);
      return { rows: rows.map(row => Object.fromEntries(Object.entries(row!).map(([key, value]) => [key, value instanceof Uint8Array ? { type: "blob", base64: Buffer.from(value).toString("base64") } : value]))), meta: { changes: 0 } };
    });
    database.exec("COMMIT");
    return Response.json({ results });
  } catch {
    database.exec("ROLLBACK");
    return Response.json({ error: "保存できませんでした。" }, { status: 503 });
  }
};
after(() => {
  globalThis.fetch = oldFetch;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  database.close();
  process.chdir(originalDirectory);
  rmSync(fixture, { recursive: true, force: true });
});
function resetJobs(): void { database.exec("DELETE FROM drive_sync_jobs"); }
function jobRow(photoId: string): Record<string, unknown> { return database.prepare("SELECT * FROM drive_sync_jobs WHERE photo_id = ?").get(photoId)!; }

test("Google mode rejects demo success and saves a durable job atomically with photo/evaluation", async () => {
  const before = await getState();
  assert.equal(before.photos[0].syncStatus, "pending", "old demo synchronized labels are not proof of Google upload");
  assert.equal(before.drive.mode, "google");
  assert.equal(before.drive.connected, false);
  assert.ok(batches[0].every(statement => !statement.sql.includes("image_bytes")));
  await assert.rejects(updateSyncStatus("legacy-photo", "synced"), /サーバーが確認/);
  const input = { userId: "owner", title: "新しい写真", image: "", sampleKey: "sky", requestId: "drive-atomic-photo" };
  const photo = await createPhoto(input);
  assert.equal((await createPhoto(input)).id, photo.id);
  assert.equal(jobRow(photo.id).requested_revision, 1);
  const save = batches.find(batch => batch[0].sql.startsWith("INSERT INTO photos"));
  assert.equal(save?.length, 3, "photo, evaluation, and upload intent commit together");
  failJobInsert = true;
  try { await assert.rejects(createPhoto({ ...input, requestId: "drive-job-rollback" })); }
  finally { failJobInsert = false; }
  assert.equal(database.prepare("SELECT id FROM photos WHERE request_id = ?").get("drive-job-rollback"), undefined);
  assert.equal(database.prepare("SELECT COUNT(*) AS count FROM evaluations").get()!.count, 2);
  assert.equal(existsSync(path.join(fixture, "work/oddshot.sqlite")), false);
});

test("owner connection backfills legacy photos exactly once and settings persist opaquely", async () => {
  resetJobs();
  const count = (await getState()).photos.length;
  assert.equal(await enqueueAllDrivePhotos(), count);
  assert.equal(await enqueueAllDrivePhotos(), 0);
  await setAppSettings([{ key: "opaque-owner-token", value: "encrypted-envelope-fixture" }, { key: "safe-folder-config", value: '{"folderId":"fixture-folder"}' }]);
  assert.equal(await getAppSetting("opaque-owner-token"), "encrypted-envelope-fixture");
  assert.equal(await getAppSetting("missing"), null);
  const consumed = await Promise.all([compareAndSetAppSetting("opaque-owner-token", "encrypted-envelope-fixture", "used"), compareAndSetAppSetting("opaque-owner-token", "encrypted-envelope-fixture", "used")]);
  assert.deepEqual(consumed, [true, false], "a one-time OAuth state cannot be consumed concurrently");
  assert.deepEqual(await Promise.all([claimAppSetting("drive_oauth_used:fixture", "used"), claimAppSetting("drive_oauth_used:fixture", "used")]), [true, false]);
  const payload = await getDrivePhotoPayload("legacy-photo");
  assert.deepEqual(Buffer.from(payload.imageBytes), bytes);
  assert.equal(payload.nickname, "保存の参加者");
  assert.equal(payload.evaluation.rank, evaluation.rank);
  assert.equal(payload.criteriaVersion, "demo-v1");
  assert.equal(payload.title, "以前の写真");
});

test("separate workers atomically claim one lease, retain file IDs, and reject stale completion", async () => {
  resetJobs();
  await enqueueDrivePhoto("legacy-photo");
  const now = Date.now();
  const [first, competitor] = await Promise.all([claimDriveJob(now), claimDriveJob(now)]);
  assert.ok(first);
  assert.equal(competitor, null);
  const ids = { imageFileId: "fixed-image-id", metadataFileId: "fixed-metadata-id" };
  assert.equal(await assignDriveFileIds(first, ids), true);
  assert.equal(await assignDriveFileIds(first, { imageFileId: "other-image", metadataFileId: "other-metadata" }), false);
  const reclaimed = await claimDriveJob(now + 10 * 60_000 + 1);
  assert.ok(reclaimed);
  assert.notEqual(reclaimed.leaseToken, first.leaseToken);
  assert.equal(reclaimed.imageFileId, ids.imageFileId);
  assert.equal(reclaimed.metadataFileId, ids.metadataFileId);
  assert.equal(await completeDriveJob(first), false);
  assert.equal(await completeDriveJob(reclaimed), true);
  assert.equal((await getState()).photos.find(photo => photo.id === "legacy-photo")?.syncStatus, "synced");
});

test("an edit during upload queues another revision while preserving score and fixed files", async () => {
  resetJobs();
  await enqueueDrivePhoto("legacy-photo");
  const job = await claimDriveJob();
  assert.ok(job);
  await assignDriveFileIds(job, { imageFileId: "revision-image", metadataFileId: "revision-metadata" });
  const before = (await getState()).ranking;
  const edited = await updatePhotoTitle("legacy-photo", "owner", "更新した写真名");
  assert.equal(edited.syncStatus, "pending");
  assert.equal(jobRow(job.photoId).status, "processing");
  assert.equal(await completeDriveJob(job), true);
  assert.equal(jobRow(job.photoId).status, "queued");
  assert.equal(jobRow(job.photoId).completed_revision, 1);
  const next = await claimDriveJob();
  assert.ok(next);
  assert.equal(next.revision, 2);
  assert.equal(next.imageFileId, "revision-image");
  assert.equal((await getDrivePhotoPayload(next.photoId)).title, edited.title);
  await completeDriveJob(next);
  assert.deepEqual((await getState()).ranking, before);
  const regenerated = await generatePhotoTitles("legacy-photo", "owner");
  assert.equal(regenerated.title, edited.title);
  assert.equal(regenerated.syncStatus, "synced", "new title suggestions do not change the Drive filename");
  assert.equal(jobRow(next.photoId).requested_revision, 2);
  const selected = await updatePhotoTitle("legacy-photo", "owner", "選び直した写真名");
  assert.equal(selected.syncStatus, "pending", "a selected title queues the image filename update");
  assert.equal(jobRow(next.photoId).requested_revision, 3);
});

test("retry backoff survives process changes and permanent failures require a retry request", async () => {
  resetJobs();
  await enqueueDrivePhoto("legacy-photo");
  const now = Date.now();
  const job = await claimDriveJob(now);
  assert.ok(job);
  await assignDriveFileIds(job, { imageFileId: "retry-image", metadataFileId: "retry-metadata" });
  assert.equal(await failDriveJob(job, "Google Drive に接続できませんでした。", { now }), true);
  assert.equal(await claimDriveJob(now + 29_999), null);
  const retry = await claimDriveJob(now + 30_000);
  assert.ok(retry);
  assert.equal(retry.attemptCount, 2);
  assert.equal(retry.imageFileId, "retry-image");
  await failDriveJob(retry, "Google Drive の保存許可を設定してください。", { retryable: false, now });
  assert.equal(await claimDriveJob(now + 86400000), null);
  assert.equal((await getState()).photos.find(photo => photo.id === job.photoId)?.syncStatus, "failed");
  await enqueueDrivePhoto(job.photoId);
  const manualRetry = await claimDriveJob();
  assert.ok(manualRetry);
  assert.equal(manualRetry.attemptCount, 1);
  assert.equal(manualRetry.metadataFileId, "retry-metadata");
  assert.equal(await completeDriveJob(retry), false);
  await completeDriveJob(manualRetry);
});

test("new edits are not stranded by failure of an older upload revision", async () => {
  resetJobs();
  await enqueueDrivePhoto("legacy-photo");
  const job = await claimDriveJob();
  assert.ok(job);
  await updatePhotoTitle(job.photoId, "owner", "失敗中に更新した名前");
  await failDriveJob(job, "再試行します。", { retryable: false });
  assert.equal(jobRow(job.photoId).status, "queued");
  const next = await claimDriveJob();
  assert.ok(next);
  assert.equal(next.revision, job.revision + 1);
  assert.equal(next.attemptCount, 1);
});

test("owner reconnect resumes failed jobs and supersedes in-flight credentials without replacing file IDs", async () => {
  resetJobs();
  await enqueueDrivePhoto("legacy-photo");
  const job = await claimDriveJob();
  assert.ok(job);
  await assignDriveFileIds(job, { imageFileId: "reconnect-image", metadataFileId: "reconnect-metadata" });
  await failDriveJob(job, "保存許可をもう一度設定してください。", { retryable: false });
  assert.ok(await enqueueAllDrivePhotos() >= 1);
  database.exec("UPDATE drive_sync_jobs SET status = 'synced', completed_revision = requested_revision WHERE photo_id != 'legacy-photo'");
  const next = await claimDriveJob();
  assert.ok(next);
  assert.equal(next.imageFileId, "reconnect-image");
  const beforeRevision = next.revision;
  await enqueueAllDrivePhotos();
  await failDriveJob(next, "以前の保存許可が無効です。", { retryable: false });
  assert.equal(jobRow(next.photoId).status, "queued");
  const withNewGrant = await claimDriveJob();
  assert.ok(withNewGrant);
  assert.equal(withNewGrant.revision, beforeRevision + 1);
  assert.equal(withNewGrant.metadataFileId, "reconnect-metadata");
});

test("the upload runner persists one image ID and recovers a lost response without JSON or duplicate media writes", async () => {
  resetJobs();
  await enqueueDrivePhoto("legacy-photo");
  assert.equal((await processDriveJobs()).paused, "disconnected");
  assert.equal(jobRow("legacy-photo").attempt_count, 0);
  const origin = "https://offline-oddshot.invalid";
  const folderId = "integration-folder";
  process.env.GOOGLE_CLIENT_ID = "integration-client-id";
  process.env.GOOGLE_CLIENT_SECRET = "integration-client-secret";
  process.env.GOOGLE_DRIVE_FOLDER_ID = folderId;
  process.env.GOOGLE_REDIRECT_URI = `${origin}/api/admin/google/callback`;
  process.env.ODDSHOT_ADMIN_SECRET = "a".repeat(64);
  process.env.ODDSHOT_GOOGLE_CREDENTIALS_KEY = Buffer.alloc(32, 17).toString("base64url");
  const scope = "https://www.googleapis.com/auth/drive.file";
  const files = new Map<string, { metadata: Record<string, unknown>; media: Buffer }>();
  let loseUploadResponse = true;
  let generated = 0;
  let uploadAttempts = 0;
  googleHandler = async (address, init) => {
    const url = new URL(address);
    if (address === "https://oauth2.googleapis.com/token") {
      assert.ok(init.body instanceof URLSearchParams);
      return Response.json({ access_token: "integration-access", token_type: "Bearer", scope, ...(init.body.get("grant_type") === "authorization_code" ? { refresh_token: "integration-refresh-secret" } : {}) });
    }
    assert.equal(url.origin, "https://www.googleapis.com", "the test cannot send photos to any external destination");
    if (url.pathname.endsWith("/generateIds")) {
      assert.equal(url.searchParams.get("count"), "1");
      generated++;
      return Response.json({ ids: ["integration-image-id"] });
    }
    if (url.pathname.endsWith(`/${folderId}`)) return Response.json({ id: folderId, name: "共通の保存先", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: true } });
    const idFromPath = url.pathname.split("/").at(-1)!;
    if (!init.method) {
      const file = files.get(idFromPath);
      return file ? Response.json({ ...file.metadata, id: idFromPath, trashed: false }) : Response.json({}, { status: 404 });
    }
    assert.ok(init.body instanceof Blob);
    const body = Buffer.from(await init.body.arrayBuffer());
    const boundary = new Headers(init.headers).get("Content-Type")!.split("boundary=")[1];
    const metadataStart = body.indexOf("\r\n\r\n") + 4;
    const metadataEnd = body.indexOf(`\r\n--${boundary}\r\n`);
    const mediaStart = body.indexOf("\r\n\r\n", metadataEnd) + 4;
    const mediaEnd = body.lastIndexOf(`\r\n--${boundary}--\r\n`);
    const metadata = JSON.parse(body.subarray(metadataStart, metadataEnd).toString("utf8")) as Record<string, unknown>;
    const id = init.method === "POST" ? String(metadata.id) : idFromPath;
    uploadAttempts++;
    assert.equal(metadata.mimeType, "image/jpeg", "evaluations are never written to Google Drive");
    files.set(id, { metadata: { ...files.get(id)?.metadata, ...metadata }, media: body.subarray(mediaStart, mediaEnd) });
    if (loseUploadResponse) return Response.json({ error: { message: "an upstream secret must never enter job errors" } }, { status: 503 });
    return Response.json({ id });
  };
  try {
    const adminCookie = createAdminSessionCookie().split(";")[0];
    const attempt = await createDriveOAuthAttempt(new Request(`${origin}/api/admin/drive/connect`, { method: "POST", headers: { origin, cookie: adminCookie } }));
    const callback = new URL(process.env.GOOGLE_REDIRECT_URI);
    callback.search = new URLSearchParams({ state: new URL(attempt.url).searchParams.get("state")!, code: "offline-code", picked_file_ids: folderId, scope }).toString();
    await finishDriveOAuth(new Request(callback, { headers: { cookie: `${adminCookie}; ${attempt.cookie.split(";")[0]}` } }));
    const stored = await getAppSetting("google_drive_connection");
    assert.ok(stored);
    assert.ok(!stored.includes("integration-refresh-secret"), "the persisted owner credential is encrypted");
    assert.equal((await getState()).drive.folderName, "共通の保存先");
    const first = await processDriveJobs();
    assert.deepEqual(first, { processed: 1, synced: 0, failed: 1 });
    assert.equal(files.size, 1);
    assert.equal(jobRow("legacy-photo").image_file_id, "integration-image-id");
    assert.equal(jobRow("legacy-photo").metadata_file_id, null);
    assert.ok(!String(jobRow("legacy-photo").last_error).includes("upstream secret"));
    assert.equal((await getState()).photos.find(photo => photo.id === "legacy-photo")?.syncStatus, "failed");
    loseUploadResponse = false;
    database.exec("UPDATE drive_sync_jobs SET next_attempt_at = '2000-01-01T00:00:00.000Z' WHERE photo_id = 'legacy-photo'");
    assert.deepEqual(await processDriveJobs(), { processed: 1, synced: 1, failed: 0 });
    assert.equal(generated, 1, "a new app instance reuses the persisted image ID after a lost response");
    assert.equal(uploadAttempts, 1, "an owned immutable image is not uploaded again");
    assert.equal(files.size, 1);
    assert.deepEqual(files.get("integration-image-id")?.media, bytes);
    assert.deepEqual((await getDrivePhotoPayload("legacy-photo")).evaluation, evaluation, "evaluation data remains in D1");
    assert.equal((await getState()).photos.find(photo => photo.id === "legacy-photo")?.syncStatus, "synced");
  } finally { googleHandler = undefined; }
});
