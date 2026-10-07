import { randomUUID } from "node:crypto";
import type { Evaluation, TitleSuggestions } from "./types";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_URL = "https://www.googleapis.com/drive/v3/files";
const UPLOAD_URL = "https://www.googleapis.com/upload/drive/v3/files";
const RESPONSE_LIMIT = 64 * 1024;
const IMAGE_LIMIT = 1.5 * 1024 * 1024;
const FILE_FIELDS = "id,mimeType,trashed,parents,appProperties";

export type GoogleDriveErrorCode = "configuration" | "payload" | "reconnect_required" | "permission" | "not_found" | "conflict" | "transient" | "timeout" | "invalid_response";
export class GoogleDriveError extends Error {
  readonly reconnectRequired: boolean;
  readonly retryable: boolean;
  constructor(message: string, public readonly code: GoogleDriveErrorCode, public readonly status = 503) {
    super(message);
    this.name = "GoogleDriveError";
    this.reconnectRequired = code === "reconnect_required";
    this.retryable = ["transient", "timeout", "invalid_response"].includes(code);
  }
}

export type GoogleDriveCredentials = { clientId: string; clientSecret: string; refreshToken: string };
export type GoogleOAuthTokens = { accessToken: string; refreshToken?: string; scope?: string; expiresIn?: number };
export type DrivePhotoFileIds = { imageFileId: string; metadataFileId: string };
export type DrivePhotoPayload = {
  photoId: string;
  userId: string;
  nickname: string;
  title: string;
  createdAt: string;
  imageBytes: Uint8Array;
  mimeType: "image/jpeg" | "image/png" | "image/webp";
  evaluation: Evaluation;
  criteriaVersion?: string;
  criteria?: unknown;
  titleSuggestions?: TitleSuggestions;
  folderId: string;
};

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function invalidResponse(): GoogleDriveError { return new GoogleDriveError("Google Drive の応答を確認できませんでした。再試行します。", "invalid_response", 502); }
function reconnect(): GoogleDriveError { return new GoogleDriveError("Google Drive の保存許可をもう一度設定してください。", "reconnect_required", 503); }
function validateSecret(value: string): void {
  if (typeof value !== "string" || !value.trim() || /[\r\n]/u.test(value)) throw new GoogleDriveError("Google Drive の接続設定を確認してください。", "configuration", 503);
}
function validateId(value: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(value)) throw new GoogleDriveError("Google Drive の保存先を確認してください。", "configuration", 503);
}
function networkError(error: unknown): GoogleDriveError {
  if (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name)) return new GoogleDriveError("Google Drive の応答に時間がかかっています。再試行します。", "timeout", 504);
  return new GoogleDriveError("Google Drive に接続できませんでした。再試行します。", "transient", 503);
}
async function request(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, redirect: "error", cache: "no-store", signal: AbortSignal.timeout(20_000) });
  } catch (error) { throw networkError(error); }
}
async function readJson(response: Response): Promise<unknown> {
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    const reader = response.body?.getReader();
    if (!reader) throw invalidResponse();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > RESPONSE_LIMIT) { await reader.cancel(); throw invalidResponse(); }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof GoogleDriveError) throw error;
    throw networkError(error);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { throw invalidResponse(); }
}

async function exchangeToken(parameters: Record<string, string>): Promise<GoogleOAuthTokens> {
  const response = await request(TOKEN_URL, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(parameters),
  });
  const payload = await readJson(response);
  if (!response.ok) {
    if (record(payload) && payload.error === "invalid_grant") throw reconnect();
    if (response.status === 429 || response.status >= 500) throw new GoogleDriveError("Google の認証に接続できませんでした。再試行します。", "transient", 503);
    throw new GoogleDriveError("Google Drive の認証設定を確認してください。", "configuration", 503);
  }
  if (!record(payload) || typeof payload.access_token !== "string" || !payload.access_token.trim()
    || (payload.token_type !== undefined && payload.token_type !== "Bearer")
    || (payload.refresh_token !== undefined && typeof payload.refresh_token !== "string")
    || (payload.scope !== undefined && typeof payload.scope !== "string")
    || (payload.expires_in !== undefined && (typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0))) throw invalidResponse();
  return {
    accessToken: payload.access_token,
    ...(typeof payload.refresh_token === "string" && payload.refresh_token ? { refreshToken: payload.refresh_token } : {}),
    ...(typeof payload.scope === "string" ? { scope: payload.scope } : {}),
    ...(typeof payload.expires_in === "number" ? { expiresIn: payload.expires_in } : {}),
  };
}

export async function exchangeOAuthCode(input: { code: string; redirectUri: string; clientId: string; clientSecret: string }): Promise<GoogleOAuthTokens> {
  for (const value of [input.code, input.redirectUri, input.clientId, input.clientSecret]) validateSecret(value);
  let redirect: URL;
  try { redirect = new URL(input.redirectUri); } catch { throw new GoogleDriveError("Google の戻り先設定を確認してください。", "configuration", 503); }
  if (redirect.username || redirect.password || redirect.hash || !(redirect.protocol === "https:" || (redirect.protocol === "http:" && ["127.0.0.1", "localhost"].includes(redirect.hostname)))) throw new GoogleDriveError("Google の戻り先設定を確認してください。", "configuration", 503);
  return exchangeToken({ code: input.code, redirect_uri: input.redirectUri, client_id: input.clientId, client_secret: input.clientSecret, grant_type: "authorization_code" });
}

export async function refreshGoogleAccessToken(credentials: GoogleDriveCredentials): Promise<string> {
  for (const value of [credentials.clientId, credentials.clientSecret, credentials.refreshToken]) validateSecret(value);
  return (await exchangeToken({ client_id: credentials.clientId, client_secret: credentials.clientSecret, refresh_token: credentials.refreshToken, grant_type: "refresh_token" })).accessToken;
}

async function failure(response: Response): Promise<GoogleDriveError> {
  if (response.status === 401) return reconnect();
  if (response.status === 404) return new GoogleDriveError("Google Drive の保存先が見つかりません。保存先をもう一度確認してください。", "not_found", 503);
  if (response.status === 409) return new GoogleDriveError("Google Drive の保存内容を確認してください。", "conflict", 503);
  if (response.status === 429 || response.status >= 500) return new GoogleDriveError("Google Drive の保存処理を完了できませんでした。再試行します。", "transient", 503);
  if (response.status === 403) {
    let payload: unknown;
    try { payload = await readJson(response); } catch { /* Error details are deliberately never surfaced. */ }
    if (record(payload) && record(payload.error) && Array.isArray(payload.error.errors)
      && payload.error.errors.some(error => record(error) && ["rateLimitExceeded", "userRateLimitExceeded", "backendError"].includes(String(error.reason)))) {
      return new GoogleDriveError("Google Drive が混み合っています。再試行します。", "transient", 503);
    }
    return new GoogleDriveError("Google Drive の保存先への書き込み許可を確認してください。", "permission", 503);
  }
  return new GoogleDriveError("Google Drive の保存設定を確認してください。", "configuration", 503);
}

type AuthorizedRequest = (url: string, init?: RequestInit) => Promise<Response>;
function accessTokenRequest(accessToken: string): AuthorizedRequest {
  validateSecret(accessToken);
  return (url, init = {}) => request(url, { ...init, headers: { ...Object.fromEntries(new Headers(init.headers)), Authorization: `Bearer ${accessToken}` } });
}
async function credentialsRequest(credentials: GoogleDriveCredentials): Promise<AuthorizedRequest> {
  let accessToken = await refreshGoogleAccessToken(credentials);
  let refreshedAfterUnauthorized = false;
  return async (url, init = {}) => {
    let response = await accessTokenRequest(accessToken)(url, init);
    if (response.status === 401 && !refreshedAfterUnauthorized) {
      await response.body?.cancel();
      accessToken = await refreshGoogleAccessToken(credentials);
      refreshedAfterUnauthorized = true;
      response = await accessTokenRequest(accessToken)(url, init);
    }
    return response;
  };
}
function urlWithQuery(base: string, query: Record<string, string>): string {
  return `${base}?${new URLSearchParams(query)}`;
}

export async function verifyDriveFolder(accessToken: string, folderId: string): Promise<{ id: string; name: string }> {
  validateId(folderId);
  const response = await accessTokenRequest(accessToken)(urlWithQuery(`${DRIVE_URL}/${encodeURIComponent(folderId)}`, { fields: "id,name,mimeType,trashed,capabilities(canAddChildren)", supportsAllDrives: "true" }));
  if (!response.ok) throw await failure(response);
  const folder = await readJson(response);
  if (!record(folder) || folder.id !== folderId || typeof folder.name !== "string") throw invalidResponse();
  if (folder.mimeType !== "application/vnd.google-apps.folder" || folder.trashed !== false || !record(folder.capabilities) || folder.capabilities.canAddChildren !== true) throw new GoogleDriveError("写真を追加できる Google Drive のフォルダを選んでください。", "permission", 503);
  return { id: folderId, name: folder.name };
}

export async function generateDriveFileIds(accessToken: string, count = 2): Promise<string[]> {
  if (!Number.isInteger(count) || count < 1 || count > 1000) throw new GoogleDriveError("Google Drive の保存内容を確認してください。", "payload", 400);
  const response = await accessTokenRequest(accessToken)(urlWithQuery(`${DRIVE_URL}/generateIds`, { count: String(count), space: "drive", type: "files" }));
  if (!response.ok) throw await failure(response);
  const payload = await readJson(response);
  if (!record(payload) || !Array.isArray(payload.ids) || payload.ids.length !== count || new Set(payload.ids).size !== count) throw invalidResponse();
  for (const id of payload.ids) {
    if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,200}$/u.test(id)) throw invalidResponse();
  }
  return payload.ids as string[];
}

function fileName(title: string, photoId: string, extension: string): string {
  const cleanTitle = Array.from(title.replace(/[\p{Cc}\p{Cf}<>:"/\\|?*]/gu, " ").replace(/\s+/gu, " ").trim()).slice(0, 70).join("") || "ODDSHOT";
  const cleanId = photoId.replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 100);
  return `${cleanTitle}_${cleanId}.${extension}`;
}

type DriveFile = { id: string; mimeType: string; trashed: boolean; parents: string[]; appProperties: Record<string, unknown> };
async function existingFile(send: AuthorizedRequest, id: string): Promise<DriveFile | undefined> {
  const response = await send(urlWithQuery(`${DRIVE_URL}/${encodeURIComponent(id)}`, { fields: FILE_FIELDS, supportsAllDrives: "true" }));
  if (response.status === 404) { await response.body?.cancel(); return undefined; }
  if (!response.ok) throw await failure(response);
  const file = await readJson(response);
  if (!record(file) || file.id !== id || typeof file.mimeType !== "string" || typeof file.trashed !== "boolean" || !Array.isArray(file.parents) || !file.parents.every(parent => typeof parent === "string") || !record(file.appProperties)) throw invalidResponse();
  return file as DriveFile;
}
function verifyOwnedFile(file: DriveFile, photoId: string, kind: "image" | "metadata", folderId: string, mimeType: string): void {
  if (file.trashed || file.mimeType !== mimeType || !file.parents.includes(folderId)
    || file.appProperties.app !== "oddshot" || file.appProperties.photoId !== photoId || file.appProperties.kind !== kind) throw new GoogleDriveError("Google Drive の保存済みファイルを確認してください。", "conflict", 503);
}
function multipart(metadata: Record<string, unknown>, bytes: Uint8Array, mimeType: string): { body: Blob; headers: Record<string, string> } {
  const boundary = `oddshot_${randomUUID()}`;
  const body = new Blob([
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n`,
    new Uint8Array(bytes), `\r\n--${boundary}--\r\n`,
  ]);
  return { body, headers: { "Content-Type": `multipart/related; boundary=${boundary}`, "Content-Length": String(body.size) } };
}
async function upsertFile(send: AuthorizedRequest, input: { id: string; name: string; bytes: Uint8Array; mimeType: string; folderId: string; photoId: string; kind: "image" | "metadata" }): Promise<void> {
  let file = await existingFile(send, input.id);
  const properties = { app: "oddshot", photoId: input.photoId, kind: input.kind };
  const metadata = { name: input.name, mimeType: input.mimeType, appProperties: properties };
  if (file) verifyOwnedFile(file, input.photoId, input.kind, input.folderId, input.mimeType);
  let response = await send(urlWithQuery(file ? `${UPLOAD_URL}/${encodeURIComponent(input.id)}` : UPLOAD_URL, { uploadType: "multipart", fields: "id", supportsAllDrives: "true" }), {
    method: file ? "PATCH" : "POST", ...multipart(file ? metadata : { ...metadata, id: input.id, parents: [input.folderId] }, input.bytes, input.mimeType),
  });
  if (!file && response.status === 409) {
    await response.body?.cancel();
    file = await existingFile(send, input.id);
    if (!file) throw new GoogleDriveError("Google Drive の保存内容を確認できませんでした。再試行します。", "transient", 503);
    verifyOwnedFile(file, input.photoId, input.kind, input.folderId, input.mimeType);
    response = await send(urlWithQuery(`${UPLOAD_URL}/${encodeURIComponent(input.id)}`, { uploadType: "multipart", fields: "id", supportsAllDrives: "true" }), { method: "PATCH", ...multipart(metadata, input.bytes, input.mimeType) });
  }
  if (!response.ok) throw await failure(response);
  const result = await readJson(response);
  if (!record(result) || result.id !== input.id) throw invalidResponse();
}

/** Fixed IDs must be saved in the database before this call so retries update the same pair. */
export async function syncDrivePhoto(credentials: GoogleDriveCredentials, payload: DrivePhotoPayload, ids: DrivePhotoFileIds): Promise<DrivePhotoFileIds> {
  for (const id of [payload.folderId, ids.imageFileId, ids.metadataFileId]) validateId(id);
  if (ids.imageFileId === ids.metadataFileId || !(payload.imageBytes instanceof Uint8Array) || !payload.imageBytes.length || payload.imageBytes.length > IMAGE_LIMIT
    || !["image/jpeg", "image/png", "image/webp"].includes(payload.mimeType)
    || typeof payload.photoId !== "string" || !/^[A-Za-z0-9_-]{1,100}$/u.test(payload.photoId) || typeof payload.title !== "string") throw new GoogleDriveError("Google Drive に保存する写真を確認してください。", "payload", 400);
  let metadataBytes: Uint8Array;
  try {
    metadataBytes = Buffer.from(JSON.stringify({
      schemaVersion: 1, photoId: payload.photoId, userId: payload.userId, nickname: payload.nickname, title: payload.title, createdAt: payload.createdAt,
      evaluation: payload.evaluation, criteriaVersion: payload.criteriaVersion ?? payload.evaluation.criteriaVersion ?? payload.evaluation.ai?.criteriaVersion,
      criteria: payload.criteria, titleSuggestions: payload.titleSuggestions,
    }, null, 2), "utf8");
  } catch { throw new GoogleDriveError("Google Drive に保存する評価を確認してください。", "payload", 400); }
  if (metadataBytes.length > 256 * 1024) throw new GoogleDriveError("Google Drive に保存する評価を確認してください。", "payload", 400);
  const send = await credentialsRequest(credentials);
  const extension = { "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[payload.mimeType];
  await upsertFile(send, { id: ids.imageFileId, name: fileName(payload.title, payload.photoId, extension), bytes: payload.imageBytes, mimeType: payload.mimeType, folderId: payload.folderId, photoId: payload.photoId, kind: "image" });
  await upsertFile(send, { id: ids.metadataFileId, name: fileName(payload.title, payload.photoId, "json"), bytes: metadataBytes, mimeType: "application/json", folderId: payload.folderId, photoId: payload.photoId, kind: "metadata" });
  return { ...ids };
}
