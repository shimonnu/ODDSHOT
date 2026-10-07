import { createDriveOAuthAttempt, DriveAuthError } from "@/lib/drive-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const attempt = await createDriveOAuthAttempt(request);
    return new Response(null, { status: 303, headers: { Location: attempt.url, "Set-Cookie": attempt.cookie, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" } });
  } catch (error) {
    const code = error instanceof DriveAuthError ? error.code : "configuration";
    return new Response(null, { status: 303, headers: { Location: `/admin/drive?drive=error&code=${encodeURIComponent(code)}`, "Cache-Control": "no-store" } });
  }
}
