import { randomUUID } from "node:crypto";
import { desc } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { quoteOverlays } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadPublicObject } from "@/lib/r2";
import { assertAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

const MAX_BYTES = 10 * 1024 * 1024;

/** GET — overlay library (any signed-in user, for the picker). */
export const GET = route(async () => {
	await requireUser();
	const rows = await db
		.select()
		.from(quoteOverlays)
		.orderBy(desc(quoteOverlays.createdAt));
	return Response.json({ overlays: rows });
});

/** POST — add an overlay PNG (ADMIN). Must be a transparent PNG (1080×1350). */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	assertAdmin(user);
	const form = await req.formData();
	const file = form.get("file");
	const label = (form.get("label") as string | null)?.slice(0, 120) ?? null;
	if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
	if (file.type !== "image/png")
		throw new HttpError(400, "Overlay must be a transparent PNG");
	if (file.size > MAX_BYTES)
		throw new HttpError(400, "PNG too large (max 10MB)");

	const bytes = await file.arrayBuffer();
	const key = `quote-overlays/${randomUUID()}.png`;
	const url = await uploadPublicObject(key, bytes, "image/png");
	const [row] = await db
		.insert(quoteOverlays)
		.values({ label, r2Key: key, url, createdByUserId: user.id })
		.returning();
	return Response.json({ overlay: row });
});
