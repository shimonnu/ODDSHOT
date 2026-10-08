import { createPhoto, errorResponse } from "@/lib/db";
import { schedulePhotoTitleCompletion } from "@/lib/title-background";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    let titleWork: Promise<void> | undefined;
    const photo = await createPhoto(await request.json(), { scheduleBackground: work => { titleWork = work; } });
    schedulePhotoTitleCompletion(titleWork);
    return Response.json(photo, { status: 201 });
  }
  catch (error) { return errorResponse(error); }
}
