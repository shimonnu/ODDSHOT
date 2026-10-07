import { errorResponse, updatePhotoTitle } from "@/lib/db";
import { scheduleDriveUpload } from "@/lib/drive-background";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function PATCH(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await request.json();
    const photo = await updatePhotoTitle(id, input?.userId, input?.title);
    scheduleDriveUpload();
    return Response.json(photo);
  } catch (error) { return errorResponse(error); }
}
