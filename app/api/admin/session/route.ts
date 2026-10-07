import { assertSameOrigin, checkAdminSecret, clearAdminSessionCookie, createAdminSessionCookie, DriveAuthError } from "@/lib/drive-auth";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    if (Number(request.headers.get("Content-Length")) > 8192) return Response.json({ error: "入力を確認してください。" }, { status: 413 });
    const input = await request.json();
    if (!checkAdminSecret(request, input?.secret)) return Response.json({ error: "管理者用の合言葉を確認してください。" }, { status: 401 });
    return Response.json({ authenticated: true }, { headers: { "Set-Cookie": createAdminSessionCookie(request), "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof DriveAuthError ? error.message : "管理者の設定を確認してください。" }, { status: error instanceof DriveAuthError ? error.status : 400 });
  }
}

export async function DELETE(request: Request) {
  try {
    assertSameOrigin(request);
    return Response.json({ authenticated: false }, { headers: { "Set-Cookie": clearAdminSessionCookie(), "Cache-Control": "no-store" } });
  } catch (error) {
    return Response.json({ error: error instanceof DriveAuthError ? error.message : "ログアウトできませんでした。" }, { status: error instanceof DriveAuthError ? error.status : 400 });
  }
}
