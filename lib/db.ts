import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { defaultScoringCriteria, decisionsScoringCriteria, demoEvaluation, isSampleKey, type SampleKey, type ScoringCriteria } from "./demo";
import { DecisionsError, getScoringConfig, scoreImage } from "./decisions";
import { suggestPhotoTitles } from "./photo-titles";
import { createD1Storage, createSqliteStorage, storageMode, StorageError, type Storage, type StorageStatement } from "./storage";
import type { AppState, Evaluation, Photo, PhotoInput, Profile, RankingEntry, SyncStatus, TitleSuggestions } from "./types";

export class ApiError extends Error {
  constructor(message: string, public readonly status = 400) { super(message); }
}

type PhotoRow = {
  id: string;
  user_id: string;
  title: string;
  title_suggestions_json: string | null;
  created_at: string;
  sample_key: string | null;
  sync_status: SyncStatus;
  sync_updated_at: string | null;
  evaluation_json: string;
  criteria_version: string;
};

type ProfileRow = { id: string; nickname: string; color: string; created_at: string };

const globalDatabase = globalThis as typeof globalThis & {
  oddshotDatabase?: DatabaseSync;
  oddshotSchemaVersion?: string;
  oddshotInFlight?: Map<string, { fingerprint: string; promise: Promise<Photo> }>;
  oddshotTitlesInFlight?: Map<string, Promise<Photo>>;
};
const maxImageBytes = 1.5 * 1024 * 1024;
const profileColors = ["#D4E97D", "#B1C7ED", "#EABFA5", "#D0BDE7", "#F0D57B"];

export function driveMode(): "demo" | "google" {
  const mode = process.env.ODDSHOT_DRIVE_MODE ?? "demo";
  if (mode !== "demo" && mode !== "google") throw new StorageError("Google Drive の保存設定を確認してください。", 503, "configuration");
  return mode;
}

function profileFromRow(row: ProfileRow): Profile {
  return { id: row.id, nickname: row.nickname, color: row.color, createdAt: row.created_at };
}

function photoFromRow(row: PhotoRow): Photo {
  return {
    id: row.id,
    userId: row.user_id,
    title: row.title,
    ...(row.title_suggestions_json ? { titleSuggestions: JSON.parse(row.title_suggestions_json) as TitleSuggestions } : {}),
    image: `/api/photos/${row.id}/image`,
    createdAt: row.created_at,
    evaluation: { ...(JSON.parse(row.evaluation_json) as Evaluation), criteriaVersion: row.criteria_version },
    syncStatus: row.sync_status,
    ...(row.sync_updated_at ? { syncUpdatedAt: row.sync_updated_at } : {}),
    isSample: row.sample_key !== null,
  };
}

function sampleFile(key: SampleKey): string {
  return path.join(process.cwd(), "public", "images", `${key}.jpg`);
}

function sampleBytes(key: SampleKey): Buffer | null {
  const file = sampleFile(key);
  return existsSync(file) ? readFileSync(file) : null;
}

function initializeCriteria(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS scoring_criteria (
    id TEXT NOT NULL, version TEXT PRIMARY KEY, criteria_json TEXT NOT NULL,
    created_at TEXT NOT NULL, is_active INTEGER NOT NULL DEFAULT 1
  )`);
  const insertCriteria = database.prepare("INSERT OR IGNORE INTO scoring_criteria (id, version, criteria_json, created_at, is_active) VALUES (?, ?, ?, ?, 0)");
  insertCriteria.run(defaultScoringCriteria.id, defaultScoringCriteria.version, JSON.stringify(defaultScoringCriteria), new Date().toISOString());
  insertCriteria.run(decisionsScoringCriteria.id, decisionsScoringCriteria.version, JSON.stringify(decisionsScoringCriteria), new Date().toISOString());
  const customActive = database.prepare("SELECT version FROM scoring_criteria WHERE is_active = 1 AND version NOT IN ('demo-v1', 'decisions-v1') LIMIT 1").get();
  database.prepare("UPDATE scoring_criteria SET is_active = 0 WHERE version = ?").run(defaultScoringCriteria.version);
  database.prepare("UPDATE scoring_criteria SET is_active = ? WHERE version = ?").run(customActive ? 0 : 1, decisionsScoringCriteria.version);
  const columns = database.prepare("PRAGMA table_info(evaluations)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "criteria_version")) {
    database.exec("ALTER TABLE evaluations ADD COLUMN criteria_version TEXT NOT NULL DEFAULT 'demo-v1'");
  }
  const photoColumns = database.prepare("PRAGMA table_info(photos)").all() as { name: string }[];
  if (!photoColumns.some((column) => column.name === "request_id")) database.exec("ALTER TABLE photos ADD COLUMN request_id TEXT");
  if (!photoColumns.some((column) => column.name === "request_fingerprint")) database.exec("ALTER TABLE photos ADD COLUMN request_fingerprint TEXT");
  if (!photoColumns.some((column) => column.name === "title_suggestions_json")) database.exec("ALTER TABLE photos ADD COLUMN title_suggestions_json TEXT");
  database.exec("CREATE UNIQUE INDEX IF NOT EXISTS photos_request_id ON photos(request_id) WHERE request_id IS NOT NULL");
  database.exec(`CREATE TABLE IF NOT EXISTS app_settings (
    setting_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS drive_sync_jobs (
    photo_id TEXT PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE,
    image_file_id TEXT, metadata_file_id TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'processing', 'synced', 'failed')),
    attempt_count INTEGER NOT NULL DEFAULT 0, next_attempt_at TEXT, lease_token TEXT, lease_until TEXT,
    requested_revision INTEGER NOT NULL DEFAULT 1, completed_revision INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS drive_sync_jobs_ready ON drive_sync_jobs(status, next_attempt_at, lease_until);
  CREATE UNIQUE INDEX IF NOT EXISTS drive_sync_jobs_lease ON drive_sync_jobs(lease_token) WHERE lease_token IS NOT NULL;`);
  globalDatabase.oddshotSchemaVersion = "google-drive-v1";
}

function hydrateSampleImages(database: DatabaseSync): void {
  const missing = database.prepare("SELECT id, sample_key FROM photos WHERE sample_key IS NOT NULL AND image_bytes IS NULL").all() as { id: string; sample_key: string }[];
  const update = database.prepare("UPDATE photos SET image_bytes = ? WHERE id = ? AND image_bytes IS NULL");
  for (const item of missing) {
    if (!isSampleKey(item.sample_key)) continue;
    const bytes = sampleBytes(item.sample_key);
    if (bytes) update.run(bytes, item.id);
  }
}

function db(): DatabaseSync {
  if (!globalDatabase.oddshotDatabase) {
    const directory = path.join(process.cwd(), "work");
    mkdirSync(directory, { recursive: true });
    const database = new DatabaseSync(path.join(directory, "oddshot.sqlite"));
    database.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY, nickname TEXT NOT NULL, nickname_key TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS photos (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES profiles(id), title TEXT NOT NULL,
        image_bytes BLOB, mime_type TEXT NOT NULL, sample_key TEXT, created_at TEXT NOT NULL,
        sync_status TEXT NOT NULL CHECK (sync_status IN ('pending', 'synced', 'failed')), sync_updated_at TEXT
      );
      CREATE TABLE IF NOT EXISTS evaluations (
        id TEXT PRIMARY KEY, photo_id TEXT NOT NULL UNIQUE REFERENCES photos(id),
        evaluation_json TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS photos_user_created ON photos(user_id, created_at DESC);
    `);
    initializeCriteria(database);
    globalDatabase.oddshotDatabase = database;
  }
  if (globalDatabase.oddshotSchemaVersion !== "google-drive-v1") initializeCriteria(globalDatabase.oddshotDatabase);
  hydrateSampleImages(globalDatabase.oddshotDatabase);
  return globalDatabase.oddshotDatabase;
}

function photoSelect(): string {
  const sync = driveMode() === "google"
    ? "CASE WHEN j.status = 'synced' AND j.completed_revision = j.requested_revision THEN 'synced' WHEN j.status = 'failed' THEN 'failed' ELSE 'pending' END AS sync_status, CASE WHEN j.status = 'synced' AND j.completed_revision = j.requested_revision THEN j.updated_at ELSE NULL END AS sync_updated_at"
    : "p.sync_status, p.sync_updated_at";
  return `SELECT p.id, p.user_id, p.title, p.title_suggestions_json, p.created_at, p.sample_key, ${sync}, e.evaluation_json, e.criteria_version FROM photos p JOIN evaluations e ON e.photo_id = p.id${driveMode() === "google" ? " LEFT JOIN drive_sync_jobs j ON j.photo_id = p.id" : ""}`;
}

function storage(): Storage {
  return storageMode() === "d1" ? createD1Storage() : createSqliteStorage(db());
}

function enqueueStatement(photoId: string, now: string, revisionChanged: boolean): StorageStatement {
  return {
    sql: `INSERT INTO drive_sync_jobs (photo_id, status, next_attempt_at, updated_at) SELECT ?, 'queued', ?, ? WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?) ON CONFLICT(photo_id) DO ${revisionChanged ? `UPDATE SET requested_revision = drive_sync_jobs.requested_revision + 1, status = CASE WHEN drive_sync_jobs.status = 'processing' THEN 'processing' ELSE 'queued' END, attempt_count = CASE WHEN drive_sync_jobs.status = 'processing' THEN drive_sync_jobs.attempt_count ELSE 0 END, next_attempt_at = excluded.next_attempt_at, last_error = NULL, updated_at = excluded.updated_at` : "NOTHING"}`,
    params: [photoId, now, now, photoId], mode: "run",
  };
}

function parseCriteria(row: { criteria_json: string } | undefined): ScoringCriteria {
  if (!row) throw new StorageError("保存先の採点基準がまだ準備されていません。", 503, "configuration");
  try {
    const criteria = JSON.parse(row.criteria_json) as ScoringCriteria | null;
    if (!criteria || typeof criteria.version !== "string" || !criteria.version || !Array.isArray(criteria.ranks) || !Array.isArray(criteria.axes)) throw new Error();
    return criteria;
  }
  catch { throw new StorageError("保存先の採点基準を確認してください。", 503, "configuration"); }
}

async function scoringCriteria(database: Storage): Promise<ScoringCriteria> {
  return parseCriteria(await database.get<{ criteria_json: string }>("SELECT criteria_json FROM scoring_criteria WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1"));
}

export async function getState(): Promise<AppState & { criteria: ScoringCriteria; drive: { mode: "demo" | "google"; connected: boolean; folderName?: string } }> {
  const database = storage();
  const results = await database.batch([
    { sql: "SELECT id, nickname, color, created_at FROM profiles ORDER BY created_at ASC, id ASC", mode: "all" },
    { sql: `${photoSelect()} ORDER BY p.created_at DESC, p.id ASC`, mode: "all" },
    { sql: "SELECT criteria_json FROM scoring_criteria WHERE is_active = 1 ORDER BY created_at DESC LIMIT 1", mode: "get" },
  ]);
  const profiles = (results[0].rows as ProfileRow[]).map(profileFromRow);
  const photos = (results[1].rows as PhotoRow[]).map(photoFromRow);
  const ranking: RankingEntry[] = profiles.map((profile) => {
    const userPhotos = photos.filter((photo) => photo.userId === profile.id);
    const sCount = userPhotos.filter((photo) => photo.evaluation.rank === "S").length;
    const aCount = userPhotos.filter((photo) => photo.evaluation.rank === "A").length;
    return { ...profile, highCount: sCount + aCount, sCount, aCount, position: 0 };
  }).sort((a, b) => b.highCount - a.highCount || b.sCount - a.sCount || a.createdAt.localeCompare(b.createdAt));
  ranking.forEach((entry, index) => {
    entry.position = index > 0 && entry.highCount === ranking[index - 1].highCount ? ranking[index - 1].position : index + 1;
  });
  const mode = driveMode();
  const connection = mode === "google" ? await (await import("./drive-auth")).getDriveConnectionConfig() : { connected: false };
  return { profiles, photos, ranking, criteria: parseCriteria(results[2].rows[0] as { criteria_json: string } | undefined), ai: getScoringConfig(), drive: { mode, connected: connection.connected, ...("folderName" in connection && connection.folderName ? { folderName: connection.folderName } : {}) } };
}

export async function createProfile(nickname: unknown): Promise<Profile> {
  if (typeof nickname !== "string") throw new ApiError("ニックネームを入力してください。");
  const clean = nickname.trim().normalize("NFKC");
  if (!clean || [...clean].length > 20) throw new ApiError("ニックネームは 1〜20 文字で入力してください。");
  const database = storage();
  const key = clean.toLocaleLowerCase("ja-JP");
  const checks = await database.batch([
    { sql: "SELECT id FROM profiles WHERE nickname_key = ?", params: [key], mode: "get" },
    { sql: "SELECT COUNT(*) AS count FROM profiles", mode: "get" },
  ]);
  if (checks[0].rows.length) throw new ApiError("その名前は登録済みです。「キミはもしかして」から選んでください。", 409);
  const count = (checks[1].rows[0] as { count: number }).count;
  const profile: Profile = { id: randomUUID(), nickname: clean, color: profileColors[count % profileColors.length], createdAt: new Date().toISOString() };
  try {
    const result = await database.run("INSERT INTO profiles (id, nickname, nickname_key, color, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(nickname_key) DO NOTHING", [profile.id, clean, key, profile.color, profile.createdAt]);
    if (result.changes !== 1) throw new ApiError("その名前は登録済みです。「キミはもしかして」から選んでください。", 409);
  } catch (error) {
    if (error instanceof Error && error.message.includes("UNIQUE")) throw new ApiError("その名前は登録済みです。「キミはもしかして」から選んでください。", 409);
    throw error;
  }
  return profile;
}

function decodeImage(image: unknown): { bytes: Buffer; mime: string } {
  if (typeof image !== "string" || image.length > Math.ceil(maxImageBytes * 4 / 3) + 100) throw new ApiError("写真は 1.5 MB 以下でアップロードしてください。", 413);
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(image);
  if (!match || match[2].length % 4 !== 0) throw new ApiError("JPEG・PNG・WebP の写真を選んでください。");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > maxImageBytes) throw new ApiError("写真は 1.5 MB 以下でアップロードしてください。", 413);
  const mime = match[1];
  const valid = mime === "image/jpeg" ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : mime === "image/png" ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 12 && bytes.subarray(0, 4).toString() === "RIFF" && bytes.subarray(8, 12).toString() === "WEBP";
  if (!valid) throw new ApiError("写真の形式を確認できませんでした。JPEG・PNG・WebP を選び直してください。");
  return { bytes, mime };
}

async function completedRequest(database: Storage, requestId: string, fingerprint: string): Promise<Photo | null> {
  const request = await database.get<{ id: string; request_fingerprint: string }>("SELECT id, request_fingerprint FROM photos WHERE request_id = ?", [requestId]);
  if (!request) return null;
  if (request.request_fingerprint !== fingerprint) throw new ApiError("この採点の識別子は別の写真に使われています。写真を選び直してください。", 409);
  const row = await database.get<PhotoRow>(`${photoSelect()} WHERE p.id = ?`, [request.id]);
  if (!row) throw new StorageError("保存済みの採点結果を確認できませんでした。", 503, "query");
  return photoFromRow(row);
}

export async function createPhoto(input: PhotoInput): Promise<Photo> {
  if (!input || typeof input !== "object") throw new ApiError("写真の情報を確認してください。");
  const database = storage();
  if (typeof input.userId !== "string" || !await database.get("SELECT id FROM profiles WHERE id = ?", [input.userId])) throw new ApiError("先にニックネームを選んでください。");
  if (typeof input.title !== "string" || [...input.title.trim()].length > 60) throw new ApiError("写真のタイトルは 60 文字以内で入力してください。");
  if (input.sampleKey !== undefined && !isSampleKey(input.sampleKey)) throw new ApiError("サンプル写真を確認してください。");
  const key = input.sampleKey as SampleKey | undefined;
  const sample = key ? sampleBytes(key) : null;
  if (key && !sample) throw new ApiError("サンプル写真を準備しています。少し待ってから再度お試しください。", 503);
  const { bytes, mime } = key && sample ? { bytes: sample, mime: "image/jpeg" } : decodeImage(input.image);
  const userId = input.userId;
  const inputTitle = input.title.trim();
  if (input.requestId !== undefined && (typeof input.requestId !== "string" || !/^[A-Za-z0-9_-]{8,128}$/.test(input.requestId))) {
    throw new ApiError("採点の識別子を確認できませんでした。写真を選び直してください。");
  }
  const requestId = input.requestId;
  const fingerprint = createHash("sha256").update(JSON.stringify({ userId, title: inputTitle, mime, sampleKey: key ?? null })).update(bytes).digest("hex");
  if (requestId) {
    const existing = await completedRequest(database, requestId, fingerprint);
    if (existing) return existing;
    const inFlight = globalDatabase.oddshotInFlight?.get(requestId);
    if (inFlight) {
      if (inFlight.fingerprint !== fingerprint) throw new ApiError("この採点の識別子は別の写真に使われています。写真を選び直してください。", 409);
      return inFlight.promise;
    }
  }
  const createdAt = new Date().toISOString();
  const id = randomUUID();
  const config = getScoringConfig();
  const operation = (async (): Promise<Photo> => {
    const criteria = await scoringCriteria(database);
    const [result, titleSuggestions] = await Promise.all([
      config.mode === "decisions"
        ? scoreImage(bytes, mime, criteria, createdAt)
        : Promise.resolve(demoEvaluation(bytes, key, createdAt, undefined, criteria)),
      inputTitle ? Promise.resolve(undefined) : safeTitleSuggestions(bytes, mime, key),
    ]);
    const title = inputTitle || titleSuggestions?.suggestions[0] || "名前のない一枚";
    const evaluation: Evaluation = { ...result, criteriaVersion: criteria.version };
    // Both writes are one batch; a competing requestId cannot create an orphan evaluation.
    await database.batch([
      {
        sql: "INSERT INTO photos (id, user_id, title, image_bytes, mime_type, sample_key, created_at, sync_status, request_id, request_fingerprint, title_suggestions_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(request_id) WHERE request_id IS NOT NULL DO NOTHING",
        params: [id, userId, title, bytes, mime, key ?? null, createdAt, "pending", requestId ?? null, requestId ? fingerprint : null, titleSuggestions ? JSON.stringify(titleSuggestions) : null], mode: "run",
      },
      {
        sql: "INSERT INTO evaluations (id, photo_id, evaluation_json, created_at, criteria_version) SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM photos WHERE id = ?)",
        params: [evaluation.id, id, JSON.stringify(evaluation), createdAt, criteria.version, id], mode: "run",
      },
      ...(driveMode() === "google" ? [enqueueStatement(id, createdAt, false)] : []),
    ]);
    if (requestId) {
      const saved = await completedRequest(database, requestId, fingerprint);
      if (!saved) throw new StorageError("写真の保存を確認できませんでした。もう一度お試しください。", 503, "query");
      return saved;
    }
    return {
      id, userId, title, image: `/api/photos/${id}/image`, createdAt,
      ...(titleSuggestions ? { titleSuggestions } : {}),
      evaluation, syncStatus: "pending", isSample: Boolean(key),
    };
  })();
  if (requestId) {
    globalDatabase.oddshotInFlight ??= new Map();
    globalDatabase.oddshotInFlight.set(requestId, { fingerprint, promise: operation });
  }
  try {
    return await operation;
  } finally {
    if (requestId && globalDatabase.oddshotInFlight?.get(requestId)?.promise === operation) globalDatabase.oddshotInFlight.delete(requestId);
  }
}

async function safeTitleSuggestions(bytes: Buffer, mime: string, sampleKey?: string): Promise<TitleSuggestions> {
  try {
    return await suggestPhotoTitles(bytes, mime, sampleKey);
  } catch {
    // A title is optional; an unavailable title service must not discard a valid score.
    return { suggestions: [], source: "unavailable" };
  }
}

async function ownedPhoto(database: Storage, id: string, userId: unknown): Promise<PhotoRow> {
  if (typeof userId !== "string" || !await database.get("SELECT id FROM profiles WHERE id = ?", [userId])) throw new ApiError("先にニックネームを選んでください。");
  const row = await database.get<PhotoRow>(`${photoSelect()} WHERE p.id = ?`, [id]);
  if (!row) throw new ApiError("写真が見つかりませんでした。", 404);
  if (row.user_id !== userId) throw new ApiError("この写真を投稿したニックネームを選んでください。", 403);
  return row;
}

export async function updatePhotoTitle(id: string, userId: unknown, title: unknown): Promise<Photo> {
  if (typeof title !== "string" || !title.trim() || [...title.trim()].length > 60) throw new ApiError("写真のタイトルは 1〜60 文字で入力してください。");
  const database = storage();
  const row = await ownedPhoto(database, id, userId);
  const clean = title.trim();
  const results = await database.batch([
    { sql: "UPDATE photos SET title = ? WHERE id = ? AND user_id = ?", params: [clean, id, row.user_id], mode: "run" },
    ...(driveMode() === "google" ? [enqueueStatement(id, new Date().toISOString(), true)] : []),
    { sql: `${photoSelect()} WHERE p.id = ?`, params: [id], mode: "get" },
  ]);
  return photoFromRow(results[results.length - 1].rows[0] as PhotoRow);
}

export async function generatePhotoTitles(id: string, userId: unknown): Promise<Photo> {
  const database = storage();
  const row = await ownedPhoto(database, id, userId);
  const running = globalDatabase.oddshotTitlesInFlight?.get(id);
  if (running) return running;
  const operation = (async (): Promise<Photo> => {
    const { bytes, mime } = await getPhotoImage(id);
    const titleSuggestions = await safeTitleSuggestions(bytes, mime, row.sample_key ?? undefined);
    if (titleSuggestions.source === "unavailable") throw new ApiError("タイトル案を取得できませんでした。少し待ってもう一度お試しください。", 502);
    // Only suggestions change, so a title edited while generation runs is preserved.
    await database.run("UPDATE photos SET title_suggestions_json = ? WHERE id = ?", [JSON.stringify(titleSuggestions), id]);
    return photoFromRow(await ownedPhoto(database, id, userId));
  })();
  globalDatabase.oddshotTitlesInFlight ??= new Map();
  globalDatabase.oddshotTitlesInFlight.set(id, operation);
  try {
    return await operation;
  } finally {
    if (globalDatabase.oddshotTitlesInFlight?.get(id) === operation) globalDatabase.oddshotTitlesInFlight.delete(id);
  }
}

export async function updateSyncStatus(id: string, status: unknown): Promise<Photo> {
  if (driveMode() === "google") throw new ApiError("Google Drive の保存結果はサーバーが確認します。", 409);
  if (status !== "pending" && status !== "synced" && status !== "failed") throw new ApiError("保存状態を確認してください。");
  const database = storage();
  const row = await database.get<PhotoRow>(`${photoSelect()} WHERE p.id = ?`, [id]);
  if (!row) throw new ApiError("写真が見つかりませんでした。", 404);
  const updatedAt = new Date().toISOString();
  const results = await database.batch([
    { sql: "UPDATE photos SET sync_status = ?, sync_updated_at = ? WHERE id = ?", params: [status, updatedAt, id], mode: "run" },
    { sql: `${photoSelect()} WHERE p.id = ?`, params: [id], mode: "get" },
  ]);
  return photoFromRow(results[1].rows[0] as PhotoRow);
}

export async function getPhotoImage(id: string): Promise<{ bytes: Buffer; mime: string }> {
  const row = await storage().get<{ image_bytes: Uint8Array | null; mime_type: string }>("SELECT image_bytes, mime_type FROM photos WHERE id = ?", [id]);
  if (!row) throw new ApiError("写真が見つかりませんでした。", 404);
  if (!row.image_bytes) throw new ApiError("写真を準備しています。", 503);
  return { bytes: Buffer.from(row.image_bytes), mime: row.mime_type };
}

export async function getAppSetting(key: string): Promise<string | null> {
  return (await storage().get<{ value_json: string }>("SELECT value_json FROM app_settings WHERE setting_key = ?", [key]))?.value_json ?? null;
}

export async function setAppSetting(key: string, value: string): Promise<void> {
  await setAppSettings([{ key, value }]);
}

export async function compareAndSetAppSetting(key: string, expectedValue: string, newValue: string): Promise<boolean> {
  return (await storage().run("UPDATE app_settings SET value_json = ?, updated_at = ? WHERE setting_key = ? AND value_json = ?", [newValue, new Date().toISOString(), key, expectedValue])).changes === 1;
}

export async function claimAppSetting(key: string, value: string): Promise<boolean> {
  return (await storage().run("INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO NOTHING", [key, value, new Date().toISOString()])).changes === 1;
}

export async function setAppSettings(settings: { key: string; value: string }[]): Promise<void> {
  if (!settings.length || settings.length > 50) throw new ApiError("設定内容を確認してください。");
  const now = new Date().toISOString();
  await storage().batch(settings.map(({ key, value }) => ({
    sql: "INSERT INTO app_settings (setting_key, value_json, updated_at) VALUES (?, ?, ?) ON CONFLICT(setting_key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at",
    params: [key, value, now], mode: "run",
  })));
}

export async function enqueueDrivePhoto(photoId: string, options: { force?: boolean } = {}): Promise<Photo> {
  if (driveMode() !== "google") throw new ApiError("Google Drive の自動保存がまだ有効になっていません。", 409);
  const database = storage();
  const now = new Date().toISOString();
  const result = await database.batch([
    enqueueStatement(photoId, now, options.force ?? false),
    { sql: "UPDATE drive_sync_jobs SET status = 'queued', attempt_count = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE photo_id = ? AND status = 'failed'", params: [now, now, photoId], mode: "run" },
    { sql: `${photoSelect()} WHERE p.id = ?`, params: [photoId], mode: "get" },
  ]);
  const row = result[2].rows[0] as PhotoRow | undefined;
  if (!row) throw new ApiError("写真が見つかりませんでした。", 404);
  return photoFromRow(row);
}

export async function enqueueAllDrivePhotos(options: { retryFailed?: boolean; refreshProcessing?: boolean } = {}): Promise<number> {
  const now = new Date().toISOString();
  const statements: StorageStatement[] = [{ sql: "INSERT INTO drive_sync_jobs (photo_id, status, next_attempt_at, updated_at) SELECT p.id, 'queued', ?, ? FROM photos p JOIN evaluations e ON e.photo_id = p.id WHERE NOT EXISTS (SELECT 1 FROM drive_sync_jobs j WHERE j.photo_id = p.id)", params: [now, now], mode: "run" }];
  if (options.retryFailed !== false) statements.push({ sql: "UPDATE drive_sync_jobs SET status = 'queued', attempt_count = 0, next_attempt_at = ?, last_error = NULL, updated_at = ? WHERE status = 'failed'", params: [now, now], mode: "run" });
  // In-flight uploads still hold their lease; an older credential failure queues this new revision.
  if (options.refreshProcessing !== false) statements.push({ sql: "UPDATE drive_sync_jobs SET requested_revision = requested_revision + 1, next_attempt_at = ?, updated_at = ? WHERE status = 'processing'", params: [now, now], mode: "run" });
  return (await storage().batch(statements)).reduce((total, result) => total + result.meta.changes, 0);
}

export type DriveJob = {
  photoId: string; imageFileId: string | null; metadataFileId: string | null;
  attemptCount: number; revision: number; leaseToken: string;
};
type DriveJobRow = {
  photo_id: string; image_file_id: string | null; metadata_file_id: string | null;
  attempt_count: number; requested_revision: number; lease_token: string;
};

export async function claimDriveJob(now = Date.now()): Promise<DriveJob | null> {
  const date = new Date(now).toISOString();
  const leaseToken = randomUUID();
  // The UPDATE and returned row are in one atomic batch, including across app instances.
  const results = await storage().batch([
    {
      sql: "UPDATE drive_sync_jobs SET status = 'processing', attempt_count = attempt_count + 1, lease_token = ?, lease_until = ?, updated_at = ? WHERE photo_id = (SELECT photo_id FROM drive_sync_jobs WHERE requested_revision > completed_revision AND ((status IN ('queued', 'failed') AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?) OR (status = 'processing' AND lease_until <= ?)) ORDER BY updated_at ASC, photo_id ASC LIMIT 1)",
      params: [leaseToken, new Date(now + 10 * 60_000).toISOString(), date, date, date], mode: "run",
    },
    { sql: "SELECT photo_id, image_file_id, metadata_file_id, attempt_count, requested_revision, lease_token FROM drive_sync_jobs WHERE lease_token = ?", params: [leaseToken], mode: "get" },
  ]);
  const row = results[1].rows[0] as DriveJobRow | undefined;
  return row ? { photoId: row.photo_id, imageFileId: row.image_file_id, metadataFileId: row.metadata_file_id, attemptCount: row.attempt_count, revision: row.requested_revision, leaseToken: row.lease_token } : null;
}

export async function assignDriveFileIds(job: DriveJob, ids: { imageFileId: string; metadataFileId?: string }): Promise<boolean> {
  return (await storage().run("UPDATE drive_sync_jobs SET image_file_id = ?, metadata_file_id = COALESCE(metadata_file_id, ?) WHERE photo_id = ? AND lease_token = ? AND status = 'processing' AND image_file_id IS NULL", [ids.imageFileId, ids.metadataFileId ?? null, job.photoId, job.leaseToken])).changes === 1;
}

export async function completeDriveJob(job: DriveJob, now = Date.now()): Promise<boolean> {
  const date = new Date(now).toISOString();
  return (await storage().run("UPDATE drive_sync_jobs SET completed_revision = ?, status = CASE WHEN requested_revision > ? THEN 'queued' ELSE 'synced' END, next_attempt_at = CASE WHEN requested_revision > ? THEN ? ELSE NULL END, attempt_count = 0, lease_token = NULL, lease_until = NULL, last_error = NULL, updated_at = ? WHERE photo_id = ? AND lease_token = ? AND status = 'processing'", [job.revision, job.revision, job.revision, date, date, job.photoId, job.leaseToken])).changes === 1;
}

export async function failDriveJob(job: DriveJob, safeError: string, options: { retryable?: boolean; now?: number } = {}): Promise<boolean> {
  const now = options.now ?? Date.now();
  const date = new Date(now).toISOString();
  const retryAt = options.retryable !== false && job.attemptCount < 8 ? new Date(now + Math.min(30 * 60_000, 30_000 * 2 ** Math.min(job.attemptCount - 1, 6))).toISOString() : null;
  return (await storage().run("UPDATE drive_sync_jobs SET status = CASE WHEN requested_revision > ? THEN 'queued' ELSE 'failed' END, next_attempt_at = CASE WHEN requested_revision > ? THEN ? ELSE ? END, attempt_count = CASE WHEN requested_revision > ? THEN 0 ELSE attempt_count END, lease_token = NULL, lease_until = NULL, last_error = ?, updated_at = ? WHERE photo_id = ? AND lease_token = ? AND status = 'processing'", [job.revision, job.revision, date, retryAt, job.revision, safeError.slice(0, 200), date, job.photoId, job.leaseToken])).changes === 1;
}

export async function getDrivePhotoPayload(photoId: string): Promise<Omit<import("./google-drive").DrivePhotoPayload, "folderId">> {
  const row = await storage().get<Pick<PhotoRow, "id" | "user_id" | "title" | "title_suggestions_json" | "created_at" | "evaluation_json" | "criteria_version"> & { image_bytes: Uint8Array | null; mime_type: string; nickname: string }>("SELECT p.id, p.user_id, p.title, p.title_suggestions_json, p.created_at, p.image_bytes, p.mime_type, u.nickname, e.evaluation_json, e.criteria_version FROM photos p JOIN evaluations e ON e.photo_id = p.id JOIN profiles u ON u.id = p.user_id WHERE p.id = ?", [photoId]);
  if (!row?.image_bytes) throw new ApiError("保存する写真を読み込めませんでした。", 503);
  if (!["image/jpeg", "image/png", "image/webp"].includes(row.mime_type)) throw new ApiError("保存する写真の形式を確認してください。", 400);
  const criteriaRow = await storage().get<{ criteria_json: string }>("SELECT criteria_json FROM scoring_criteria WHERE version = ?", [row.criteria_version]);
  return {
    photoId: row.id, userId: row.user_id, nickname: row.nickname, title: row.title,
    createdAt: row.created_at, imageBytes: row.image_bytes,
    mimeType: row.mime_type as "image/jpeg" | "image/png" | "image/webp",
    evaluation: JSON.parse(row.evaluation_json) as Evaluation, criteriaVersion: row.criteria_version,
    ...(criteriaRow ? { criteria: JSON.parse(criteriaRow.criteria_json) as unknown } : {}),
    ...(row.title_suggestions_json ? { titleSuggestions: JSON.parse(row.title_suggestions_json) as TitleSuggestions } : {}),
  };
}

export function errorResponse(error: unknown): Response {
  if (error instanceof ApiError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof DecisionsError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof StorageError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof SyntaxError) return Response.json({ error: "入力内容を確認してください。" }, { status: 400 });
  console.error("Oddshot database request failed", { name: error instanceof Error ? error.name : "UnknownError" });
  return Response.json({ error: "保存に失敗しました。少し待ってから再度お試しください。" }, { status: 500 });
}
