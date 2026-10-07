import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { exchangeOAuthCode, GoogleDriveError, verifyDriveFolder } from "./google-drive";
import type { GoogleDriveCredentials } from "./google-drive";

const ADMIN_COOKIE = "oddshot_admin";
const OAUTH_COOKIE = "oddshot_drive_oauth";
const CONNECTION_SETTING = "google_drive_connection";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SESSION_SECONDS = 8 * 60 * 60;
const OAUTH_SECONDS = 10 * 60;
const failureCounts = new Map<string, { count: number; expiresAt: number }>();

export type DriveAuthErrorCode = "configuration" | "unauthorized" | "csrf" | "rate_limit" | "state" | "cancelled" | "folder" | "scope" | "reconnect_required" | "connection";
export class DriveAuthError extends Error {
  constructor(message: string, public readonly code: DriveAuthErrorCode, public readonly status = 400) { super(message); this.name = "DriveAuthError"; }
}
type Configuration = { clientId: string; clientSecret: string; folderId: string; redirectUri: string; origin: string; key: Buffer };
type Session = { version: 1; nonce: string; issuedAt: number; expiresAt: number; origin: string };
type OAuthAttempt = { version: 1; state: string; sessionHash: string; issuedAt: number; expiresAt: number; redirectUri: string; clientId: string; folderId: string };
type DriveConnection = { refreshToken: string; folderId: string; folderName: string; clientId: string; connectedAt: string };
export type DriveAdminStatus = { configured: boolean; connected: boolean; folderName?: string; redirectUri?: string; message?: string };

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function configurationError(): DriveAuthError { return new DriveAuthError("Google Drive の管理設定を確認してください。", "configuration", 503); }
function stateError(): DriveAuthError { return new DriveAuthError("保存許可の確認期限が切れたか、確認情報が一致しません。管理画面からやり直してください。", "state", 400); }
function seconds(): number { return Math.floor(Date.now() / 1000); }
function hash(value: string): string { return createHash("sha256").update(value).digest("base64url"); }
function constantEqual(left: string, right: string): boolean { return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest()); }
function driveMode(): "demo" | "google" {
  const mode = process.env.ODDSHOT_DRIVE_MODE ?? "demo";
  if (mode !== "demo" && mode !== "google") throw configurationError();
  return mode;
}
function adminSecret(): string {
  const secret = process.env.ODDSHOT_ADMIN_SECRET;
  if (!secret || secret.length < 32 || secret.length > 512 || /[\r\n]/u.test(secret)) throw configurationError();
  return secret;
}
function redirectConfig(): { redirectUri: string; origin: string; secure: boolean } {
  const value = process.env.GOOGLE_REDIRECT_URI;
  if (!value || value.length > 2048) throw configurationError();
  let url: URL;
  try { url = new URL(value); } catch { throw configurationError(); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === "https:" || (url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname)))) throw configurationError();
  return { redirectUri: value, origin: url.origin, secure: url.protocol === "https:" };
}
function configuration(): Configuration {
  const clientId = process.env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID?.trim();
  const encodedKey = process.env.ODDSHOT_GOOGLE_CREDENTIALS_KEY?.trim();
  if (!clientId || clientId.length > 512 || /[\r\n]/u.test(clientId) || !clientSecret || clientSecret.length > 1024 || /[\r\n]/u.test(clientSecret)
    || !folderId || !/^[A-Za-z0-9_-]{1,200}$/u.test(folderId) || !encodedKey || !/^[A-Za-z0-9_-]{43}$/u.test(encodedKey)) throw configurationError();
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32 || key.toString("base64url") !== encodedKey) throw configurationError();
  return { clientId, clientSecret, folderId, key, ...redirectConfig() };
}
function cookieValue(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header || header.length > 8192) return undefined;
  const values = header.split(";").map(part => part.trim()).filter(part => part.startsWith(`${name}=`)).map(part => part.slice(name.length + 1));
  return values.length === 1 && values[0].length <= 3072 ? values[0] : undefined;
}
function sign(domain: string, value: unknown): string {
  const body = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const signature = createHmac("sha256", adminSecret()).update(`${domain}.${body}`).digest("base64url");
  return `${body}.${signature}`;
}
function readSigned(domain: string, token: string | undefined): unknown {
  if (!token || token.length > 3072 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/u.test(token)) return undefined;
  const [body, signature] = token.split(".");
  const expected = createHmac("sha256", adminSecret()).update(`${domain}.${body}`).digest("base64url");
  if (!constantEqual(signature, expected)) return undefined;
  try { return JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return undefined; }
}
function cookie(name: string, value: string, maxAge: number): string {
  const secure = redirectConfig().secure;
  return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}
function requestMatchesConfiguredOrigin(request: Request): boolean {
  const configured = new URL(redirectConfig().redirectUri);
  const host = request.headers.get("host");
  // NextRequest normalizes loopback URLs to localhost and can use an internal server origin.
  // Accept only the exact configured public Host, never a forwarded host supplied by a caller.
  return host !== null ? host.toLowerCase() === configured.host.toLowerCase() : new URL(request.url).origin === configured.origin;
}
function session(request: Request): Session | undefined {
  const origin = redirectConfig().origin;
  if (!requestMatchesConfiguredOrigin(request)) return undefined;
  const value = readSigned("oddshot-admin-session-v1", cookieValue(request, ADMIN_COOKIE));
  const now = seconds();
  if (!record(value) || value.version !== 1 || typeof value.nonce !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.nonce) || value.origin !== origin
    || typeof value.issuedAt !== "number" || !Number.isInteger(value.issuedAt) || value.issuedAt > now + 30 || typeof value.expiresAt !== "number"
    || value.expiresAt <= now || value.expiresAt - value.issuedAt !== SESSION_SECONDS) return undefined;
  return value as Session;
}

export function createAdminSessionCookie(request?: Request): string {
  const origin = redirectConfig().origin;
  if (request && !requestMatchesConfiguredOrigin(request)) throw new DriveAuthError("管理画面の接続元を確認してください。", "csrf", 403);
  const issuedAt = seconds();
  return cookie(ADMIN_COOKIE, sign("oddshot-admin-session-v1", { version: 1, nonce: randomBytes(32).toString("base64url"), issuedAt, expiresAt: issuedAt + SESSION_SECONDS, origin }), SESSION_SECONDS);
}
export function clearAdminSessionCookie(): string { return cookie(ADMIN_COOKIE, "", 0); }
export function clearOAuthCookie(): string { return cookie(OAUTH_COOKIE, "", 0); }
export function isAdminRequest(request: Request): boolean { try { return Boolean(session(request)); } catch { return false; } }
export function requireAdminRequest(request: Request): void {
  adminSecret();
  if (!session(request)) throw new DriveAuthError("管理者の確認が必要です。", "unauthorized", 401);
}
export function assertSameOrigin(request: Request): void {
  const expected = redirectConfig().origin;
  const origin = request.headers.get("origin");
  const allowed = requestMatchesConfiguredOrigin(request) && (origin !== null ? origin === expected : request.headers.get("sec-fetch-site") === "same-origin");
  if (!allowed) throw new DriveAuthError("管理画面から操作をやり直してください。", "csrf", 403);
}
/** This bounded process-local limit supplements the hosting platform's request limits. */
export function checkAdminSecret(request: Request, candidate: unknown): boolean {
  assertSameOrigin(request);
  const expected = adminSecret();
  const now = seconds();
  for (const [key, value] of failureCounts) if (value.expiresAt <= now) failureCounts.delete(key);
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "unknown";
  const rawAddress = forwarded.length <= 64 && /^[A-Fa-f0-9.:]+$/u.test(forwarded) ? forwarded : "unknown";
  const address = createHmac("sha256", expected).update(rawAddress).digest("base64url");
  const failures = failureCounts.get(address);
  if (failures && failures.count >= 5) throw new DriveAuthError("しばらく待ってから管理者の確認をやり直してください。", "rate_limit", 429);
  const valid = typeof candidate === "string" && candidate.length <= 512 && constantEqual(candidate, expected);
  if (valid) { failureCounts.delete(address); return true; }
  if (!failureCounts.has(address) && failureCounts.size >= 512) failureCounts.delete(failureCounts.keys().next().value!);
  failureCounts.set(address, { count: (failures?.count ?? 0) + 1, expiresAt: failures?.expiresAt ?? now + 10 * 60 });
  return false;
}

function associatedData(config: Configuration): Buffer { return Buffer.from(`oddshot-google-drive-connection-v1\0${config.clientId}\0${config.folderId}`, "utf8"); }
function encryptConnection(connection: DriveConnection, config: Configuration): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", config.key, iv);
  cipher.setAAD(associatedData(config));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(connection), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("base64url"), tag: cipher.getAuthTag().toString("base64url"), ciphertext: ciphertext.toString("base64url") });
}
function decryptConnection(stored: string, config: Configuration): DriveConnection {
  try {
    if (stored.length > 16 * 1024) throw new Error();
    const envelope: unknown = JSON.parse(stored);
    if (!record(envelope) || envelope.version !== 1 || typeof envelope.iv !== "string" || typeof envelope.tag !== "string" || typeof envelope.ciphertext !== "string"
      || !/^[A-Za-z0-9_-]{16}$/u.test(envelope.iv) || !/^[A-Za-z0-9_-]{22}$/u.test(envelope.tag) || !/^[A-Za-z0-9_-]+$/u.test(envelope.ciphertext)) throw new Error();
    const decipher = createDecipheriv("aes-256-gcm", config.key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(associatedData(config));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]).toString("utf8"));
    if (!record(value) || typeof value.refreshToken !== "string" || !value.refreshToken || value.refreshToken.length > 4096 || /[\r\n]/u.test(value.refreshToken)
      || value.folderId !== config.folderId || value.clientId !== config.clientId || typeof value.folderName !== "string" || value.folderName.length > 1000
      || typeof value.connectedAt !== "string" || !Number.isFinite(Date.parse(value.connectedAt))) throw new Error();
    return value as DriveConnection;
  } catch { throw new DriveAuthError("保存済みの Google Drive 接続を確認できません。管理設定を確認して再接続してください。", "configuration", 503); }
}
async function storedConnection(config: Configuration): Promise<DriveConnection | null> {
  const { getAppSetting } = await import("./db");
  const stored = await getAppSetting(CONNECTION_SETTING);
  return stored ? decryptConnection(stored, config) : null;
}

export async function getDriveCredentials(): Promise<{ credentials: GoogleDriveCredentials; folderId: string } | null> {
  if (driveMode() === "demo") return null;
  let config: Configuration;
  try { config = configuration(); } catch { return null; }
  const connection = await storedConnection(config);
  if (!connection) return null;
  return { credentials: { clientId: config.clientId, clientSecret: config.clientSecret, refreshToken: connection.refreshToken }, folderId: connection.folderId };
}
export async function getDriveConnectionConfig(): Promise<{ mode: "demo" | "google"; connected: boolean; folderId?: string; folderName?: string }> {
  const mode = driveMode();
  if (mode === "demo") return { mode, connected: false };
  try {
    const config = configuration();
    const connection = await storedConnection(config);
    return connection ? { mode, connected: true, folderId: connection.folderId, folderName: connection.folderName } : { mode, connected: false, folderId: config.folderId };
  } catch (error) {
    if (error instanceof DriveAuthError) return { mode, connected: false };
    throw error;
  }
}
export async function getDriveAdminStatus(): Promise<DriveAdminStatus> {
  let config: Configuration;
  try { adminSecret(); config = configuration(); } catch { return { configured: false, connected: false, message: "Google Drive の管理設定を準備してください。" }; }
  if (driveMode() === "demo") return { configured: false, connected: false, redirectUri: config.redirectUri, message: "Google Drive 同期を有効にする準備中です。" };
  try {
    const connection = await storedConnection(config);
    return { configured: true, connected: Boolean(connection), redirectUri: config.redirectUri, ...(connection ? { folderName: connection.folderName } : { message: "管理者として Google に保存許可を与えてください。" }) };
  } catch (error) {
    if (error instanceof DriveAuthError) return { configured: true, connected: false, redirectUri: config.redirectUri, message: error.message };
    throw error;
  }
}

export async function createDriveOAuthAttempt(request: Request): Promise<{ url: string; cookie: string }> {
  assertSameOrigin(request);
  requireAdminRequest(request);
  if (driveMode() !== "google") throw new DriveAuthError("Google Drive 同期を有効にする準備中です。", "configuration", 503);
  const config = configuration();
  const admin = session(request)!;
  const issuedAt = seconds();
  const attempt: OAuthAttempt = { version: 1, state: randomBytes(32).toString("base64url"), sessionHash: hash(admin.nonce), issuedAt, expiresAt: issuedAt + OAUTH_SECONDS, redirectUri: config.redirectUri, clientId: config.clientId, folderId: config.folderId };
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({ client_id: config.clientId, redirect_uri: config.redirectUri, response_type: "code", scope: DRIVE_SCOPE, access_type: "offline", prompt: "consent", include_granted_scopes: "false", trigger_onepick: "true", allow_folder_selection: "true", allow_multiple: "false", mimetypes: "application/vnd.google-apps.folder", file_ids: config.folderId, state: attempt.state }).toString();
  return { url: url.toString(), cookie: cookie(OAUTH_COOKIE, sign("oddshot-drive-oauth-v1", attempt), OAUTH_SECONDS) };
}

export async function finishDriveOAuth(request: Request): Promise<void> {
  requireAdminRequest(request);
  if (driveMode() !== "google") throw configurationError();
  const config = configuration();
  const url = new URL(request.url);
  const callback = new URL(config.redirectUri);
  if (request.method !== "GET" || !requestMatchesConfiguredOrigin(request) || url.pathname !== callback.pathname) throw stateError();
  const value = readSigned("oddshot-drive-oauth-v1", cookieValue(request, OAUTH_COOKIE));
  const now = seconds();
  const state = url.searchParams.get("state");
  if (!record(value) || value.version !== 1 || typeof value.state !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(value.state) || !state || !constantEqual(state, value.state)
    || value.sessionHash !== hash(session(request)!.nonce) || value.redirectUri !== config.redirectUri || value.clientId !== config.clientId || value.folderId !== config.folderId
    || typeof value.issuedAt !== "number" || !Number.isInteger(value.issuedAt) || value.issuedAt > now + 30 || typeof value.expiresAt !== "number" || value.expiresAt <= now
    || value.expiresAt - value.issuedAt !== OAUTH_SECONDS || ["state", "code", "picked_file_ids", "scope", "error"].some(key => url.searchParams.getAll(key).length > 1)) throw stateError();
  if (url.searchParams.has("error")) throw new DriveAuthError("Google Drive の保存許可がキャンセルされました。", "cancelled", 400);
  const code = url.searchParams.get("code");
  if (!code || code.length > 4096 || /[\r\n]/u.test(code)) throw stateError();
  if (url.searchParams.get("picked_file_ids") !== config.folderId) throw new DriveAuthError("指定した保存先フォルダを選んでください。", "folder", 400);
  const callbackScope = url.searchParams.get("scope");
  if (callbackScope !== null && callbackScope !== DRIVE_SCOPE) throw new DriveAuthError("写真保存の許可を確認してやり直してください。", "scope", 400);
  const { claimAppSetting, setAppSettings } = await import("./db");
  if (!await claimAppSetting(`drive_oauth_used:${hash(value.state)}`, new Date().toISOString())) throw stateError();
  try {
    const tokens = await exchangeOAuthCode({ code, redirectUri: config.redirectUri, clientId: config.clientId, clientSecret: config.clientSecret });
    if (tokens.scope !== undefined && tokens.scope !== DRIVE_SCOPE) throw new DriveAuthError("写真保存の許可を確認してやり直してください。", "scope", 400);
    const folder = await verifyDriveFolder(tokens.accessToken, config.folderId);
    const prior = tokens.refreshToken ? null : await storedConnection(config);
    const refreshToken = tokens.refreshToken ?? prior?.refreshToken;
    if (!refreshToken) throw new DriveAuthError("継続して写真を保存する許可を取得できませんでした。Google に再接続してください。", "reconnect_required", 400);
    const connection: DriveConnection = { refreshToken, folderId: folder.id, folderName: folder.name, clientId: config.clientId, connectedAt: new Date().toISOString() };
    await setAppSettings([{ key: CONNECTION_SETTING, value: encryptConnection(connection, config) }]);
  } catch (error) {
    if (error instanceof DriveAuthError) throw error;
    if (error instanceof GoogleDriveError) throw new DriveAuthError(error.message, error.reconnectRequired ? "reconnect_required" : "connection", error.status);
    throw new DriveAuthError("Google Drive の保存許可を保存できませんでした。管理画面からやり直してください。", "connection", 503);
  }
}
