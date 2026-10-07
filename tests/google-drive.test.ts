import assert from "node:assert/strict";
import test from "node:test";
import { exchangeOAuthCode, generateDriveFileIds, GoogleDriveError, refreshGoogleAccessToken, syncDrivePhoto, verifyDriveFolder } from "../lib/google-drive";
import type { DrivePhotoPayload } from "../lib/google-drive";

const credentials = { clientId: "client-id", clientSecret: "secret-client-value", refreshToken: "secret-refresh-value" };
const ids = { imageFileId: "image-file-id", metadataFileId: "metadata-file-id" };
const payload: DrivePhotoPayload = {
  photoId: "photo-uuid", userId: "user-uuid", nickname: "宇宙太郎", title: "星の記憶/禁止\n文字", createdAt: "2026-10-08T00:00:00.000Z",
  imageBytes: new Uint8Array([255, 216, 255, 0, 23]), mimeType: "image/jpeg", folderId: "folder-id",
  evaluation: { id: "eval-id", score: 90, rank: "S", reason: "星空を連想させる光", tags: ["星"], axes: { atmosphere: 25, light: 25, symbolism: 20, story: 20 }, createdAt: "2026-10-08T00:00:00.000Z", isDemo: false, criteriaVersion: "decisions-v1" },
  criteria: { axes: ["atmosphere", "light"] }, titleSuggestions: { suggestions: ["星の記憶"], source: "ai" },
};
function json(value: unknown, status = 200): Response { return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } }); }
function file(id: string, kind: "image" | "metadata", overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, mimeType: kind === "image" ? "image/jpeg" : "application/json", trashed: false, parents: [payload.folderId], appProperties: { app: "oddshot", photoId: payload.photoId, kind }, ...overrides };
}
function token(): Response { return json({ access_token: "secret-access-value", token_type: "Bearer", expires_in: 3600 }); }
type Call = { url: string; init: RequestInit };
async function withFetch(handler: (call: Call, index: number) => Promise<Response> | Response, execute: (calls: Call[]) => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  try { await execute(calls); } finally { globalThis.fetch = previous; }
}
async function multipartParts(call: Call): Promise<{ metadata: Record<string, unknown>; media: Buffer }> {
  assert(call.init.body instanceof Blob);
  const contentType = new Headers(call.init.headers).get("Content-Type") ?? "";
  const boundary = contentType.split("boundary=")[1];
  assert(boundary);
  const bytes = Buffer.from(await call.init.body.arrayBuffer());
  const separator = Buffer.from(`\r\n--${boundary}\r\n`);
  const metadataEnd = bytes.indexOf(separator);
  const metadataStart = bytes.indexOf(Buffer.from("\r\n\r\n")) + 4;
  const mediaStart = bytes.indexOf(Buffer.from("\r\n\r\n"), metadataEnd) + 4;
  const mediaEnd = bytes.lastIndexOf(Buffer.from(`\r\n--${boundary}--\r\n`));
  assert.equal(Number(new Headers(call.init.headers).get("Content-Length")), bytes.length);
  return { metadata: JSON.parse(bytes.subarray(metadataStart, metadataEnd).toString("utf8")), media: bytes.subarray(mediaStart, mediaEnd) };
}

test("OAuth code and refresh token exchanges use bounded form requests and return safe typed tokens", async () => {
  await withFetch(() => json({ access_token: "new-access", refresh_token: "new-refresh", scope: "https://www.googleapis.com/auth/drive.file", expires_in: 3600, token_type: "Bearer" }), async calls => {
    const result = await exchangeOAuthCode({ ...credentials, code: "google-code", redirectUri: "http://127.0.0.1:3001/api/admin/google/callback" });
    assert.deepEqual(result, { accessToken: "new-access", refreshToken: "new-refresh", scope: "https://www.googleapis.com/auth/drive.file", expiresIn: 3600 });
    assert.equal(calls[0].url, "https://oauth2.googleapis.com/token");
    assert(calls[0].init.body instanceof URLSearchParams);
    assert.equal(calls[0].init.body.get("grant_type"), "authorization_code");
    assert.equal(calls[0].init.body.get("client_secret"), credentials.clientSecret);
    assert.equal(calls[0].init.redirect, "error");
    assert.equal(calls[0].init.cache, "no-store");
    assert(calls[0].init.signal);
    assert.equal(await refreshGoogleAccessToken(credentials), "new-access");
    assert(calls[1].init.body instanceof URLSearchParams);
    assert.equal(calls[1].init.body.get("grant_type"), "refresh_token");
  });
});

test("invalid_grant requests reconnect without exposing credentials or upstream descriptions", async () => {
  await withFetch(() => json({ error: "invalid_grant", error_description: `${credentials.clientSecret} ${credentials.refreshToken}` }, 400), async () => {
    await assert.rejects(refreshGoogleAccessToken(credentials), error => {
      assert(error instanceof GoogleDriveError);
      assert.equal(error.code, "reconnect_required");
      assert.equal(error.reconnectRequired, true);
      assert.equal(error.retryable, false);
      assert(!String(error).includes("secret-"));
      return true;
    });
  });
});

test("folder verification requires a writable, untrashed folder and IDs are unique", async () => {
  await withFetch(({ url }) => url.includes("generateIds") ? json({ ids: [ids.imageFileId, ids.metadataFileId] }) : json({ id: payload.folderId, name: "ODDSHOT", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: true } }), async calls => {
    assert.deepEqual(await verifyDriveFolder("access", payload.folderId), { id: payload.folderId, name: "ODDSHOT" });
    assert.deepEqual(await generateDriveFileIds("access"), [ids.imageFileId, ids.metadataFileId]);
    assert.equal(new URL(calls[0].url).searchParams.get("supportsAllDrives"), "true");
    assert.equal(new URL(calls[1].url).searchParams.get("count"), "2");
  });
  await withFetch(() => json({ id: payload.folderId, name: "ODDSHOT", mimeType: "application/vnd.google-apps.folder", trashed: false, capabilities: { canAddChildren: false } }), async () => {
    await assert.rejects(verifyDriveFolder("access", payload.folderId), (error: unknown) => error instanceof GoogleDriveError && error.code === "permission");
  });
  await withFetch(() => json({ ids: [ids.imageFileId, ids.imageFileId] }), async () => {
    await assert.rejects(generateDriveFileIds("access"), (error: unknown) => error instanceof GoogleDriveError && error.code === "invalid_response");
  });
});

test("new photo creates image and JSON with fixed IDs, correct bytes, and full evaluation", async () => {
  await withFetch(async ({ url, init }) => {
    if (url.includes("oauth2")) return token();
    if (init.method === "POST") {
      const { metadata } = await multipartParts({ url, init });
      return json({ id: metadata.id });
    }
    return json({ error: "not_found" }, 404);
  }, async calls => {
    assert.deepEqual(await syncDrivePhoto(credentials, payload, ids), ids);
    const uploads = calls.filter(call => call.init.method === "POST" && call.url.includes("/upload/"));
    assert.equal(uploads.length, 2);
    const image = await multipartParts(uploads[0]);
    assert.deepEqual(image.media, Buffer.from(payload.imageBytes));
    assert.deepEqual(image.metadata, { id: ids.imageFileId, name: "星の記憶 禁止 文字_photo-uuid.jpg", mimeType: "image/jpeg", parents: [payload.folderId], appProperties: { app: "oddshot", photoId: payload.photoId, kind: "image" } });
    const metadataFile = await multipartParts(uploads[1]);
    const document = JSON.parse(metadataFile.media.toString("utf8"));
    assert.equal(metadataFile.metadata.id, ids.metadataFileId);
    assert.equal(metadataFile.metadata.mimeType, "application/json");
    assert.equal(document.photoId, payload.photoId);
    assert.equal(document.nickname, payload.nickname);
    assert.equal(document.userId, payload.userId);
    assert.deepEqual(document.evaluation, payload.evaluation);
    assert.deepEqual(document.criteria, payload.criteria);
    assert.equal(document.criteriaVersion, "decisions-v1");
    assert.deepEqual(document.titleSuggestions, payload.titleSuggestions);
    assert(!metadataFile.media.toString("utf8").includes(credentials.refreshToken));
  });
});

test("retry updates owned existing IDs and never creates a duplicate after a partial failure", async () => {
  let phase = 0;
  let imagePresent = false;
  await withFetch(async ({ url, init }) => {
    if (url.includes("oauth2")) return token();
    const image = url.includes(ids.imageFileId);
    if (!init.method) return image && imagePresent ? json(file(ids.imageFileId, "image")) : json({}, 404);
    const { metadata } = await multipartParts({ url, init });
    if (metadata.mimeType === "image/jpeg") { imagePresent = true; return json({ id: ids.imageFileId }); }
    return phase === 0 ? json({ error: { message: "server unavailable secret-access-value" } }, 503) : json({ id: ids.metadataFileId });
  }, async calls => {
    await assert.rejects(syncDrivePhoto(credentials, payload, ids), (error: unknown) => error instanceof GoogleDriveError && error.retryable && !String(error).includes("secret-access-value"));
    phase = 1;
    assert.deepEqual(await syncDrivePhoto(credentials, payload, ids), ids);
    const imageUploads = calls.filter(call => call.url.includes("/upload/") && (call.init.method === "POST" || call.init.method === "PATCH"));
    assert.equal(imageUploads[0].init.method, "POST");
    assert.equal(imageUploads[2].init.method, "PATCH");
    assert.equal(new URL(imageUploads[2].url).pathname.endsWith(ids.imageFileId), true);
    assert.equal((await multipartParts(imageUploads[2])).metadata.id, undefined);
  });
});

test("a 409 creation race checks ownership and updates the winning file", async () => {
  let imageChecks = 0;
  await withFetch(async ({ url, init }) => {
    if (url.includes("oauth2")) return token();
    if (!init.method && url.includes(ids.imageFileId)) return ++imageChecks === 1 ? json({}, 404) : json(file(ids.imageFileId, "image"));
    if (!init.method) return json(file(ids.metadataFileId, "metadata"));
    const { metadata } = await multipartParts({ url, init });
    if (init.method === "POST") return json({}, 409);
    return json({ id: metadata.mimeType === "image/jpeg" ? ids.imageFileId : ids.metadataFileId });
  }, async calls => {
    await syncDrivePhoto(credentials, payload, ids);
    assert.equal(calls.filter(call => call.init.method === "POST" && call.url.includes("/upload/")).length, 1);
    assert.equal(calls.filter(call => call.init.method === "PATCH").length, 2);
  });
});

test("an ID belonging to another photo or folder is never overwritten", async () => {
  for (const overrides of [
    { appProperties: { app: "oddshot", photoId: "another-photo", kind: "image" } },
    { parents: ["another-folder"] },
    { trashed: true },
  ]) {
    await withFetch(({ url }) => url.includes("oauth2") ? token() : json(file(ids.imageFileId, "image", overrides)), async calls => {
      await assert.rejects(syncDrivePhoto(credentials, payload, ids), (error: unknown) => error instanceof GoogleDriveError && error.code === "conflict");
      assert.equal(calls.filter(call => call.url.includes("/upload/")).length, 0);
    });
  }
});

test("one unauthorized response refreshes once and retries the same fixed-ID request", async () => {
  let refreshed = 0;
  let unauthorized = false;
  await withFetch(async ({ url, init }) => {
    if (url.includes("oauth2")) { refreshed++; return json({ access_token: `access-${refreshed}`, token_type: "Bearer" }); }
    if (!unauthorized) { unauthorized = true; return json({}, 401); }
    if (!init.method) return json({}, 404);
    const { metadata } = await multipartParts({ url, init });
    return json({ id: metadata.id });
  }, async calls => {
    await syncDrivePhoto(credentials, payload, ids);
    assert.equal(refreshed, 2);
    const checks = calls.filter(call => call.url.includes(ids.imageFileId) && !call.init.method);
    assert.equal(checks.length, 2);
    assert.equal(new Headers(checks[0].init.headers).get("Authorization"), "Bearer access-1");
    assert.equal(new Headers(checks[1].init.headers).get("Authorization"), "Bearer access-2");
  });
  await withFetch(({ url }) => url.includes("oauth2") ? token() : json({}, 401), async calls => {
    await assert.rejects(syncDrivePhoto(credentials, payload, ids), (error: unknown) => error instanceof GoogleDriveError && error.reconnectRequired);
    assert.equal(calls.filter(call => call.url.includes("oauth2")).length, 2);
  });
});

test("network failures, oversized responses, and invalid input remain safe and bounded", async () => {
  await withFetch(() => { throw new Error(`${credentials.refreshToken} unavailable`); }, async () => {
    await assert.rejects(refreshGoogleAccessToken(credentials), (error: unknown) => error instanceof GoogleDriveError && error.retryable && !String(error).includes(credentials.refreshToken));
  });
  await withFetch(() => new Response("x".repeat(65537)), async () => {
    await assert.rejects(refreshGoogleAccessToken(credentials), (error: unknown) => error instanceof GoogleDriveError && error.code === "invalid_response");
  });
  await withFetch(() => { throw new Error("Must not send any request"); }, async calls => {
    await assert.rejects(syncDrivePhoto(credentials, { ...payload, imageBytes: new Uint8Array(1.5 * 1024 * 1024 + 1) }, ids), (error: unknown) => error instanceof GoogleDriveError && error.code === "payload");
    await assert.rejects(syncDrivePhoto(credentials, payload, { imageFileId: ids.imageFileId, metadataFileId: ids.imageFileId }), (error: unknown) => error instanceof GoogleDriveError && error.code === "payload");
    await assert.rejects(exchangeOAuthCode({ ...credentials, code: "code", redirectUri: "http://untrusted.example/callback" }), (error: unknown) => error instanceof GoogleDriveError && error.code === "configuration");
    assert.equal(calls.length, 0);
  });
});
