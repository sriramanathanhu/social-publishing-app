import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { presignPutUrl } from "@/lib/r2";

export const runtime = "nodejs";

const MAX_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB

const schema = z.object({
	name: z.string().min(1).max(300),
	type: z.string().max(120).default("video/mp4"),
	size: z.number().int().nonnegative().max(MAX_BYTES),
});

/**
 * POST /api/video/presign — issue a short-lived signed PUT URL so the browser
 * uploads the video straight to R2 (no app-server buffering, no Cloudflare body
 * limit). Returns { uploadUrl, key, url }; the caller PUTs to uploadUrl with the
 * same Content-Type, then records via POST /api/video.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	if (!input.type.startsWith("video/")) {
		throw new HttpError(400, "Upload a video file");
	}
	const ext =
		input.name
			.split(".")
			.pop()
			?.toLowerCase()
			.replace(/[^a-z0-9]/g, "") || "mp4";
	const key = `user-videos/${user.id}/${randomUUID()}.${ext}`;
	const { uploadUrl, publicUrl } = await presignPutUrl(key, input.type);
	return Response.json({ uploadUrl, key, url: publicUrl });
});
