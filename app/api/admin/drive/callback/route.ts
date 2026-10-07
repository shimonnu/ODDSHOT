import { clearOAuthCookie, DriveAuthError, finishDriveOAuth } from "@/lib/drive-auth";
import { enqueueAllDrivePhotos } from "@/lib/db";
import { scheduleDriveUpload } from "@/lib/drive-background";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function GET(request: Request) {
  let location = "/admin/drive?drive=connected";
  try {
    await finishDriveOAuth(request);
    await enqueueAllDrivePhotos();
    scheduleDriveUpload();
  } catch (error) {
    const code = error instanceof DriveAuthError ? error.code : "connection";
    location = `/admin/drive?drive=error&code=${encodeURIComponent(code)}`;
  }
  return new Response(null, { status: 303, headers: { Location: location, "Set-Cookie": clearOAuthCookie(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
}
