import { createPhoto, errorResponse } from "@/lib/db";
import { scheduleDriveUpload } from "@/lib/drive-background";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    const photo = await createPhoto(await request.json());
    scheduleDriveUpload();
    return Response.json(photo, { status: 201 });
  }
  catch (error) { return errorResponse(error); }
}
