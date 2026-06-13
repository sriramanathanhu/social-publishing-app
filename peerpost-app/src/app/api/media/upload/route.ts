import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { postpeer } from "@/lib/postpeer";

const schema = z.object({
	filename: z.string().min(1),
	mimeType: z.string().regex(/^(image|video)\//, "Only image/* or video/* allowed"),
});

/**
 * POST /api/media/upload
 *
 * Step 1 of PostPeer's 3-step media flow: returns a presigned S3 `uploadUrl`
 * and the `publicUrl` to reference in a post's mediaItems. The browser then
 * PUTs the file straight to S3 (step 2) and includes publicUrl when posting
 * (step 3). We just gate the presign behind auth.
 */
export const POST = route(async (request: NextRequest) => {
	await requireUser();
	const input = schema.parse(await request.json());
	const presigned = await postpeer.presignMedia(input);
	return Response.json(presigned);
});
