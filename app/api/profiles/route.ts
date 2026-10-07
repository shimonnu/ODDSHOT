import { createProfile, errorResponse } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    const input = await request.json();
    return Response.json(await createProfile(input?.nickname), { status: 201 });
  } catch (error) { return errorResponse(error); }
}
