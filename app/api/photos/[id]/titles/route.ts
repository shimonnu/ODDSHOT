import { errorResponse, generatePhotoTitles } from "@/lib/db";
import { scheduleDriveUpload } from "@/lib/drive-background";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const input = await request.json();
    const photo = await generatePhotoTitles(id, input?.userId);
    scheduleDriveUpload();
    return Response.json(photo);
  } catch (error) { return errorResponse(error); }
}
