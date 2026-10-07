import { driveMode, enqueueDrivePhoto, errorResponse, updateSyncStatus } from "@/lib/db";
import { scheduleDriveUpload } from "@/lib/drive-background";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await request.json();
    if (driveMode() === "google") {
      if (input?.status !== "pending") return Response.json({ error: "Google Drive の保存状態はサーバーが確認します。" }, { status: 409 });
      const photo = await enqueueDrivePhoto(id);
      scheduleDriveUpload();
      return Response.json(photo);
    }
    return Response.json(await updateSyncStatus(id, input?.status));
  } catch (error) { return errorResponse(error); }
}
