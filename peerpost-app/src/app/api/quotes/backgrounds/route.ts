import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { quoteBackgrounds } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadPublicObject } from "@/lib/r2";
import { assertAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

const MAX_BYTES = 15 * 1024 * 1024;
const EXT: Record<string, string> = {
	"image/jpeg": "jpg",
	"image/png": "png",
	"image/webp": "webp",
};

/** GET — the curated background library (any signed-in user, for the picker). */
export const GET = route(async () => {
	await requireUser();
	const rows = await db
		.select()
		.from(quoteBackgrounds)
		.orderBy(desc(quoteBackgrounds.createdAt));
	return Response.json({ backgrounds: rows });
});

/** POST — add a background photo to the library (ADMIN). multipart: file, label? */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	assertAdmin(user);

	const form = await req.formData();
	const file = form.get("file");
	const label = (form.get("label") as string | null)?.slice(0, 120) ?? null;
	if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
	const ext = EXT[file.type];
	if (!ext) throw new HttpError(400, "Use a JPEG, PNG, or WebP image");
	if (file.size > MAX_BYTES)
		throw new HttpError(400, "Image too large (max 15MB)");

	const bytes = await file.arrayBuffer();
	const key = `quote-bg/${randomUUID()}.${ext}`;
	const url = await uploadPublicObject(key, bytes, file.type);

	const [row] = await db
		.insert(quoteBackgrounds)
		.values({ label, r2Key: key, url, createdByUserId: user.id })
		.returning();
	return Response.json({ background: row });
});
