import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { randomBytes } from "node:crypto";
import {
  assertSameOrigin, checkAdminSecret, clearAdminSessionCookie, clearOAuthCookie, createAdminSessionCookie, createDriveOAuthAttempt,
  DriveAuthError, finishDriveOAuth, getDriveAdminStatus, getDriveConnectionConfig, getDriveCredentials, isAdminRequest, requireAdminRequest,
} from "../lib/drive-auth";

const ENV_KEYS = ["ODDSHOT_STORAGE_MODE", "ODDSHOT_D1_WORKER_URL", "ODDSHOT_D1_WORKER_TOKEN", "ODDSHOT_DRIVE_MODE", "ODDSHOT_ADMIN_SECRET", "ODDSHOT_GOOGLE_CREDENTIALS_KEY", "GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "GOOGLE_DRIVE_FOLDER_ID", "GOOGLE_REDIRECT_URI", "GOOGLE_REFRESH_TOKEN"];
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
const originalFetch = globalThis.fetch;
const originalNow = Date.now;
const adminSecret = "only-in-offline-tests-admin-secret-value";
const encryptionKey = randomBytes(32).toString("base64url");
const origin = "http://127.0.0.1:3001";
const redirectUri = `${origin}/api/admin/drive/callback`;
const scope = "https://www.googleapis.com/auth/drive.file";
Object.assign(process.env, {
  ODDSHOT_STORAGE_MODE: "d1", ODDSHOT_D1_WORKER_URL: "https://drive-auth-offline.invalid", ODDSHOT_D1_WORKER_TOKEN: "offline-test-token",
  ODDSHOT_DRIVE_MODE: "google", ODDSHOT_ADMIN_SECRET: adminSecret, ODDSHOT_GOOGLE_CREDENTIALS_KEY: encryptionKey,
  GOOGLE_CLIENT_ID: "offline-client-id", GOOGLE_CLIENT_SECRET: "offline-client-secret", GOOGLE_DRIVE_FOLDER_ID: "owner-folder", GOOGLE_REDIRECT_URI: redirectUri,
  GOOGLE_REFRESH_TOKEN: "must-never-use-env-refresh-token",
});
const database = new DatabaseSync(":memory:");
database.exec("CREATE TABLE app_settings (setting_key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL)");
type Statement = { sql: string; params: (string | number | null)[]; mode: "get" | "all" | "run" };
let googleCalls = 0;
let settingsCalls = 0;
let googleResponse: (url: string, init: RequestInit) => Response = url => {
  if (url === "https://oauth2.googleapis.com/token") return Response.json({ access_token: "offline-access-secret", refresh_token: "offline-refresh-secret", scope, token_type: "Bearer", expires_in: 3600 });
  assert.equal(new URL(url).pathname, "/drive/v3/files/owner-folder");
  return Response.json({ id: "owner-folder", name: "宇宙の写真", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: true } });
};
const normalGoogleResponse = googleResponse;
globalThis.fetch = async (url, init = {}) => {
  if (String(url) !== "https://drive-auth-offline.invalid/query") {
    assert(["oauth2.googleapis.com", "www.googleapis.com"].includes(new URL(String(url)).hostname), "Tests must never contact a real service");
    googleCalls++;
    return googleResponse(String(url), init);
  }
  settingsCalls++;
  const { statements } = JSON.parse(String(init.body)) as { statements: Statement[] };
  const results = statements.map(statement => {
    const query = database.prepare(statement.sql);
    if (statement.mode === "run") return { rows: [], meta: { changes: Number(query.run(...statement.params).changes) } };
    return { rows: statement.mode === "get" ? [query.get(...statement.params)].filter(Boolean) : query.all(...statement.params), meta: { changes: 0 } };
  });
  return Response.json({ results });
};
after(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
  for (const [key, value] of Object.entries(savedEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  database.close();
});
function cookieHeader(...cookies: string[]): string { return cookies.map(cookie => cookie.split(";")[0]).join("; "); }
function adminRequest(cookie = createAdminSessionCookie()): Request {
  return new Request(`${origin}/api/admin/drive/connect`, { method: "POST", headers: { Origin: origin, Cookie: cookieHeader(cookie) } });
}
async function attempt(): Promise<{ state: string; cookies: string }> {
  const admin = createAdminSessionCookie();
  const started = await createDriveOAuthAttempt(adminRequest(admin));
  return { state: new URL(started.url).searchParams.get("state")!, cookies: cookieHeader(admin, started.cookie) };
}
function callback(attempt: { state: string; cookies: string }, overrides: Record<string, string> = {}): Request {
  const url = new URL(redirectUri);
  url.search = new URLSearchParams({ code: "offline-code", picked_file_ids: "owner-folder", scope, state: attempt.state, ...overrides }).toString();
  return new Request(url, { headers: { Cookie: attempt.cookies } });
}
function isError(code: string) { return (error: unknown): boolean => error instanceof DriveAuthError && error.code === code && !String(error).includes("offline-refresh-secret"); }

test("demo state and admin setup status never touch new database tables or refresh-token env fallback", async () => {
  process.env.ODDSHOT_DRIVE_MODE = "demo";
  const count = settingsCalls;
  assert.deepEqual(await getDriveConnectionConfig(), { mode: "demo", connected: false });
  assert.equal(await getDriveCredentials(), null);
  const status = await getDriveAdminStatus();
  assert.equal(status.configured, false);
  assert.equal(status.connected, false);
  assert.equal(status.redirectUri, redirectUri);
  assert(status.message?.includes("準備中"));
  await assert.rejects(createDriveOAuthAttempt(adminRequest()), isError("configuration"));
  assert.equal(settingsCalls, count);
  process.env.ODDSHOT_DRIVE_MODE = "google";
  assert.equal(await getDriveCredentials(), null, "A plaintext GOOGLE_REFRESH_TOKEN must never silently connect the owner");
});

test("admin cookies are signed, expire after eight hours, and reject forgery, duplicate cookies and config changes", () => {
  const now = Date.now();
  const cookie = createAdminSessionCookie();
  assert(cookie.includes("HttpOnly; SameSite=Lax; Max-Age=28800"));
  assert(!cookie.includes("Secure"));
  assert(isAdminRequest(adminRequest(cookie)));
  assert.doesNotThrow(() => requireAdminRequest(adminRequest(cookie)));
  const [prefix, value] = cookie.split(";")[0].split("=");
  const forged = `${prefix}=${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
  assert.equal(isAdminRequest(adminRequest(forged)), false);
  assert.equal(isAdminRequest(new Request(`${origin}/api/admin/drive/status`, { headers: { Cookie: `${cookieHeader(cookie)}; ${cookieHeader(cookie)}` } })), false);
  Date.now = () => now + 8 * 60 * 60 * 1000 + 1000;
  assert.equal(isAdminRequest(adminRequest(cookie)), false);
  Date.now = originalNow;
  process.env.ODDSHOT_ADMIN_SECRET = "rotated-admin-secret-that-is-long-enough";
  assert.equal(isAdminRequest(adminRequest(cookie)), false);
  process.env.ODDSHOT_ADMIN_SECRET = adminSecret;
  process.env.GOOGLE_REDIRECT_URI = "https://public.example/api/admin/drive/callback";
  assert(createAdminSessionCookie().includes("; Secure"));
  assert.equal(isAdminRequest(adminRequest(cookie)), false);
  process.env.GOOGLE_REDIRECT_URI = redirectUri;
  assert(clearAdminSessionCookie().includes("Max-Age=0"));
  assert(clearOAuthCookie().includes("Max-Age=0"));
});

test("admin mutations require the configured origin and login failures are rate limited without plaintext IP storage", () => {
  assert.doesNotThrow(() => assertSameOrigin(adminRequest()));
  assert.doesNotThrow(() => assertSameOrigin(new Request(`${origin}/api/admin/test`, { method: "POST", headers: { "Sec-Fetch-Site": "same-origin" } })));
  const rejectedHeaders: Record<string, string>[] = [{ Origin: "https://evil.example", "Sec-Fetch-Site": "same-origin" }, { Origin: "null" }, {}];
  for (const headers of rejectedHeaders) {
    assert.throws(() => assertSameOrigin(new Request(`${origin}/api/admin/test`, { method: "POST", headers })), isError("csrf"));
  }
  assert.throws(() => assertSameOrigin(new Request("http://localhost:3001/api/admin/test", { headers: { Origin: origin } })), isError("csrf"), "localhost cannot substitute for an explicitly configured 127.0.0.1 origin");
  const login = new Request(`${origin}/api/admin/login`, { method: "POST", headers: { Origin: origin, "x-forwarded-for": "192.0.2.5" } });
  for (let index = 0; index < 5; index++) assert.equal(checkAdminSecret(login, "wrong"), false);
  assert.throws(() => checkAdminSecret(login, adminSecret), isError("rate_limit"));
  const another = new Request(`${origin}/api/admin/login`, { method: "POST", headers: { Origin: origin, "x-forwarded-for": "192.0.2.6" } });
  assert.equal(checkAdminSecret(another, adminSecret), true);
  const now = Date.now();
  Date.now = () => now + 601_000;
  assert.equal(checkAdminSecret(login, adminSecret), true);
  Date.now = originalNow;
});

test("Next's normalized/internal URL works only with the exact configured public Host and Origin", async () => {
  const request = new Request("http://localhost:3001/api/admin/drive/connect", { method: "POST", headers: { Host: "127.0.0.1:3001", Origin: origin } });
  assert.doesNotThrow(() => assertSameOrigin(request));
  assert.equal(checkAdminSecret(request, adminSecret), true);
  const cookie = createAdminSessionCookie(request);
  const authenticated = new Request(request.url, { method: "POST", headers: { Host: "127.0.0.1:3001", Origin: origin, Cookie: cookieHeader(cookie) } });
  assert.equal(isAdminRequest(authenticated), true);
  const started = await createDriveOAuthAttempt(authenticated);
  const completed = new URL("http://localhost:3001/api/admin/drive/callback");
  completed.search = new URLSearchParams({ state: new URL(started.url).searchParams.get("state")!, code: "offline-code", picked_file_ids: "owner-folder", scope }).toString();
  await finishDriveOAuth(new Request(completed, { headers: { Host: "127.0.0.1:3001", Cookie: cookieHeader(cookie, started.cookie) } }));
  database.prepare("DELETE FROM app_settings WHERE setting_key = 'google_drive_connection'").run();
  for (const host of ["localhost:3001", "evil.example", "127.0.0.1:3002", "127.0.0.1:3001, evil.example"]) {
    const invalid = new Request(`${origin}/api/admin/drive/connect`, { method: "POST", headers: { Host: host, Origin: origin, "X-Forwarded-Host": "127.0.0.1:3001", Cookie: cookieHeader(cookie) } });
    assert.throws(() => assertSameOrigin(invalid), isError("csrf"));
    assert.equal(isAdminRequest(invalid), false);
  }
  assert.throws(() => assertSameOrigin(new Request(request.url, { method: "POST", headers: { Host: "127.0.0.1:3001", Origin: "http://localhost:3001" } })), isError("csrf"));
  const wrongPath = new URL(completed);
  wrongPath.pathname = "/api/admin/other/callback";
  await assert.rejects(finishDriveOAuth(new Request(wrongPath, { headers: { Host: "127.0.0.1:3001", Cookie: cookieHeader(cookie, started.cookie) } })), isError("state"));
});

test("OAuth redirect requests only drive.file, filters the existing folder, and binds signed state to the administrator", async () => {
  const started = await createDriveOAuthAttempt(adminRequest());
  const url = new URL(started.url);
  assert.equal(url.origin, "https://accounts.google.com");
  for (const [key, value] of Object.entries({ scope, access_type: "offline", prompt: "consent", trigger_onepick: "true", allow_folder_selection: "true", file_ids: "owner-folder", redirect_uri: redirectUri, include_granted_scopes: "false" })) assert.equal(url.searchParams.get(key), value);
  assert(started.cookie.includes("HttpOnly; SameSite=Lax; Max-Age=600"));
  assert(!started.url.includes(adminSecret));
  assert(!started.url.includes(process.env.GOOGLE_CLIENT_SECRET!));
});

test("invalid state, expiry, another admin session, wrong folder, and broad scopes cannot contact Google", async () => {
  const started = await attempt();
  const count = googleCalls;
  await assert.rejects(finishDriveOAuth(callback(started, { state: "forged-state" })), isError("state"));
  await assert.rejects(finishDriveOAuth(callback(started, { picked_file_ids: "other-folder" })), isError("folder"));
  await assert.rejects(finishDriveOAuth(callback(started, { scope: "https://www.googleapis.com/auth/drive" })), isError("scope"));
  await assert.rejects(finishDriveOAuth(callback(started, { error: "access_denied" })), isError("cancelled"));
  const newAdminCookies = `${cookieHeader(createAdminSessionCookie())}; ${started.cookies.split("; ")[1]}`;
  await assert.rejects(finishDriveOAuth(callback({ ...started, cookies: newAdminCookies })), isError("state"));
  const duplicated = new URL(callback(started).url);
  duplicated.searchParams.append("code", "other-code");
  await assert.rejects(finishDriveOAuth(new Request(duplicated, { headers: { Cookie: started.cookies } })), isError("state"));
  const now = Date.now();
  Date.now = () => now + 601_000;
  await assert.rejects(finishDriveOAuth(callback(started)), isError("state"));
  Date.now = originalNow;
  assert.equal(googleCalls, count);
});

test("successful owner consent persists encrypted credentials and only exposes safe connection metadata", async () => {
  const started = await attempt();
  await finishDriveOAuth(callback(started));
  const stored = (database.prepare("SELECT value_json FROM app_settings WHERE setting_key = 'google_drive_connection'").get() as { value_json: string }).value_json;
  assert(!stored.includes("offline-refresh-secret"));
  assert(!stored.includes("宇宙の写真"));
  assert(!stored.includes("owner-folder"));
  assert.deepEqual(await getDriveConnectionConfig(), { mode: "google", connected: true, folderId: "owner-folder", folderName: "宇宙の写真" });
  assert.deepEqual(await getDriveCredentials(), { credentials: { clientId: "offline-client-id", clientSecret: "offline-client-secret", refreshToken: "offline-refresh-secret" }, folderId: "owner-folder" });
  const status = await getDriveAdminStatus();
  assert.equal(status.connected, true);
  assert.equal(status.folderName, "宇宙の写真");
  assert(!JSON.stringify(status).includes("offline-refresh-secret"));
  assert(!JSON.stringify(status).includes("offline-client-secret"));
  const count = googleCalls;
  await assert.rejects(finishDriveOAuth(callback(started)), isError("state"));
  assert.equal(googleCalls, count, "The persistent nonce claim must prevent code replay before Google is contacted");
});

test("encrypted credentials fail safely after tampering, key rotation or client/folder configuration changes", async () => {
  const row = database.prepare("SELECT value_json FROM app_settings WHERE setting_key = 'google_drive_connection'").get() as { value_json: string };
  const original = row.value_json;
  const envelope = JSON.parse(original);
  envelope.ciphertext = `${envelope.ciphertext[0] === "A" ? "B" : "A"}${envelope.ciphertext.slice(1)}`;
  database.prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'google_drive_connection'").run(JSON.stringify(envelope));
  await assert.rejects(getDriveCredentials(), isError("configuration"));
  assert.equal((await getDriveConnectionConfig()).connected, false);
  assert.equal((await getDriveAdminStatus()).connected, false);
  database.prepare("UPDATE app_settings SET value_json = ? WHERE setting_key = 'google_drive_connection'").run(original);
  for (const [key, temporary, previous] of [
    ["ODDSHOT_GOOGLE_CREDENTIALS_KEY", randomBytes(32).toString("base64url"), encryptionKey],
    ["GOOGLE_CLIENT_ID", "different-client", "offline-client-id"],
    ["GOOGLE_DRIVE_FOLDER_ID", "different-folder", "owner-folder"],
  ]) {
    process.env[key] = temporary;
    await assert.rejects(getDriveCredentials(), isError("configuration"));
    process.env[key] = previous;
  }
  assert.equal((await getDriveCredentials())?.credentials.refreshToken, "offline-refresh-secret");
});

test("concurrent OAuth callbacks consume the nonce once, and missing refresh grants cannot fabricate a connection", async () => {
  const started = await attempt();
  const count = googleCalls;
  const results = await Promise.allSettled([finishDriveOAuth(callback(started)), finishDriveOAuth(callback(started))]);
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(results.filter(result => result.status === "rejected" && result.reason instanceof DriveAuthError && result.reason.code === "state").length, 1);
  assert.equal(googleCalls - count, 2);
  database.prepare("DELETE FROM app_settings WHERE setting_key = 'google_drive_connection'").run();
  googleResponse = (url, init) => url.includes("oauth2") ? Response.json({ access_token: "access-only", scope, token_type: "Bearer" }) : normalGoogleResponse(url, init);
  await assert.rejects(finishDriveOAuth(callback(await attempt())), isError("reconnect_required"));
  assert.equal(await getDriveCredentials(), null);
  googleResponse = normalGoogleResponse;
});

test("a readonly folder and a granted broader token scope cannot replace the owner connection", async () => {
  googleResponse = (url, init) => url.includes("oauth2") ? normalGoogleResponse(url, init) : Response.json({ id: "owner-folder", name: "readonly", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: false } });
  await assert.rejects(finishDriveOAuth(callback(await attempt())), isError("connection"));
  googleResponse = (url, init) => url.includes("oauth2") ? Response.json({ access_token: "access", refresh_token: "refresh", scope: `${scope} https://www.googleapis.com/auth/drive`, token_type: "Bearer" }) : normalGoogleResponse(url, init);
  await assert.rejects(finishDriveOAuth(callback(await attempt())), isError("scope"));
  assert.equal(await getDriveCredentials(), null);
  googleResponse = normalGoogleResponse;
});
