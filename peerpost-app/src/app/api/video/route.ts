import { randomUUID } from "node:crypto";
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { userVideos } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadPublicObject } from "@/lib/r2";

export const runtime = "nodejs";

const MAX_BYTES = 500 * 1024 * 1024; // 500 MB

/** GET /api/video — the caller's uploaded videos (recent first). */
export const GET = route(async () => {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(userVideos)
		.where(eq(userVideos.userId, user.id))
		.orderBy(desc(userVideos.createdAt))
		.limit(200);
	return Response.json({ videos: rows });
});

/** POST /api/video — upload a video file to R2 and record it. */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const form = await req.formData();
	const file = form.get("file");
	if (!(file instanceof File)) throw new HttpError(400, "No file uploaded");
	if (!file.type.startsWith("video/")) {
		throw new HttpError(400, "Upload a video file");
	}
	if (file.size > MAX_BYTES)
		throw new HttpError(413, "File too large (max 500MB)");

	const ext =
		file.name
			.split(".")
			.pop()
			?.toLowerCase()
			.replace(/[^a-z0-9]/g, "") || "mp4";
	const key = `user-videos/${user.id}/${randomUUID()}.${ext}`;
	const url = await uploadPublicObject(
		key,
		await file.arrayBuffer(),
		file.type || "video/mp4",
	);
	const [row] = await db
		.insert(userVideos)
		.values({
			userId: user.id,
			title: file.name.replace(/\.[^.]+$/, "") || "Untitled",
			r2Key: key,
			url,
			contentType: file.type || null,
			sizeBytes: file.size,
		})
		.returning();
	return Response.json({ video: row });
});
