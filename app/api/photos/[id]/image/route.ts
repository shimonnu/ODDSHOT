import { errorResponse, getPhotoImage } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    const { bytes, mime } = await getPhotoImage(id);
    return new Response(new Uint8Array(bytes), { headers: {
      "Content-Type": mime,
      "Cache-Control": "private, max-age=86400, immutable",
      "X-Content-Type-Options": "nosniff",
    } });
  } catch (error) { return errorResponse(error); }
}
