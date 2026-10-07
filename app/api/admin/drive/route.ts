import { DriveAuthError, getDriveAdminStatus, requireAdminRequest } from "@/lib/drive-auth";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    requireAdminRequest(request);
    return Response.json({ authenticated: true, ...await getDriveAdminStatus() }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ authenticated: false, error: error instanceof DriveAuthError ? error.message : "Google Drive の準備状況を確認できませんでした。" }, { status: error instanceof DriveAuthError ? error.status : 503, headers: { "Cache-Control": "no-store" } });
  }
}
