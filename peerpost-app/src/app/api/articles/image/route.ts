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
	"image/gif": "gif",
};

/**
 * POST /api/articles/image — any signed-in user uploads an image to attach to a
 * published article. Returns { url } to use as a post mediaItem.
 */
export const POST = route(async (req: NextRequest) => {
	await requireUser();
	const form = await req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
	const ext = EXT[file.type];
	if (!ext) throw new HttpError(400, "Use a JPEG, PNG, WebP, or GIF image");
	if (file.size > MAX_BYTES)
		throw new HttpError(400, "Image too large (max 15MB)");

	const bytes = await file.arrayBuffer();
	const url = await uploadPublicObject(
		`article-images/${randomUUID()}.${ext}`,
		bytes,
		file.type,
	);
	return Response.json({ url });
});
