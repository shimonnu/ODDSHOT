import { createHash, timingSafeEqual } from "node:crypto";
import { assertSameOrigin, DriveAuthError, requireAdminRequest } from "@/lib/drive-auth";
import { processDriveJobs } from "@/lib/drive-sync";

export const runtime = "nodejs";
export const maxDuration = 300;

function schedulerAuthorized(request: Request): boolean {
  const secret = process.env.ODDSHOT_SYNC_SECRET?.trim();
  if (!secret || secret.length < 32) return false;
  const supplied = request.headers.get("Authorization") ?? "";
  if (supplied.length > 4096) return false;
  return timingSafeEqual(createHash("sha256").update(supplied).digest(), createHash("sha256").update(`Bearer ${secret}`).digest());
}

export async function POST(request: Request) {
  try {
    if (!schedulerAuthorized(request)) {
      requireAdminRequest(request);
      assertSameOrigin(request);
    }
    return Response.json(await processDriveJobs({ limit: 1 }), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof DriveAuthError ? error.message : "Google Drive の保存処理を開始できませんでした。" }, { status: error instanceof DriveAuthError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
