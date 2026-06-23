import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadPublicObject } from "@/lib/r2";

export const runtime = "nodejs";

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * POST /api/transcribe/upload — upload an audio file to R2 and return a public
 * URL the sidecar can fetch for transcription.
 */
export const POST = route(async (req: NextRequest) => {
	await requireUser();
	const form = await req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
	if (!file.type.startsWith("audio/") && !file.type.startsWith("video/")) {
		throw new HttpError(400, "Upload an audio file");
	}
	if (file.size > MAX_BYTES)
		throw new HttpError(413, "File too large (max 200MB)");

	const ext =
		file.name
			.split(".")
			.pop()
			?.toLowerCase()
			.replace(/[^a-z0-9]/g, "") || "bin";
	const url = await uploadPublicObject(
		`transcribe-audio/${randomUUID()}.${ext}`,
		await file.arrayBuffer(),
		file.type || "application/octet-stream",
	);
	return Response.json({ url });
});
