import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadPublicObject } from "@/lib/r2";

export const runtime = "nodejs";

const MAX_BYTES = 15 * 1024 * 1024;
const EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/**
 * POST /api/quotes/card-bg — any signed-in user uploads a one-off background for
 * a card (not added to the shared library). Returns { url } for the renderer.
 */
export const POST = route(async (req: NextRequest) => {
	await requireUser();
	const form = await req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
	const ext = EXT[file.type];
	if (!ext) throw new HttpError(400, "Use a JPEG, PNG, or WebP image");
	if (file.size > MAX_BYTES)
		throw new HttpError(400, "Image too large (max 15MB)");

	const bytes = await file.arrayBuffer();
	const url = await uploadPublicObject(
		`quote-bg-uploads/${randomUUID()}.${ext}`,
		bytes,
		file.type,
	);
	return Response.json({ url });
});
