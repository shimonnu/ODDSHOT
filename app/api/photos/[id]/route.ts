import { errorResponse, getPhoto } from "@/lib/db";

export const runtime = "nodejs";

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await context.params;
    return Response.json(await getPhoto(id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return errorResponse(error); }
}
