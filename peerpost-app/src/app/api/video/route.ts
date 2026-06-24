import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { userVideos } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadStreamObject } from "@/lib/r2";

export const runtime = "nodejs";
export const maxDuration = 800;

const MAX_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

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

/**
 * POST /api/video — STREAM a video straight to R2 (no in-memory buffering), then
 * record it. The body is the raw file bytes; the name + type come from headers
 * (`x-filename`, `Content-Type`). Streaming keeps memory bounded so back-to-back
 * uploads don't wedge the process.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	if (!req.body) throw new HttpError(400, "No file uploaded");

	const contentType = req.headers.get("content-type") || "video/mp4";
	if (!contentType.startsWith("video/")) {
		throw new HttpError(400, "Upload a video file");
	}
	const size = Number(req.headers.get("content-length") || 0);
	if (size > MAX_BYTES) throw new HttpError(413, "File too large (max 2GB)");

	const name = decodeURIComponent(
		req.headers.get("x-filename") || "video.mp4",
	).slice(0, 200);
	const ext =
		name
			.split(".")
			.pop()
			?.toLowerCase()
			.replace(/[^a-z0-9]/g, "") || "mp4";
	const key = `user-videos/${user.id}/${randomUUID()}.${ext}`;

	// Web ReadableStream → Node Readable, fed to a multipart upload.
	const body = Readable.fromWeb(
		req.body as Parameters<typeof Readable.fromWeb>[0],
	);
	const url = await uploadStreamObject(key, body, contentType);

	const [row] = await db
		.insert(userVideos)
		.values({
			userId: user.id,
			title: name.replace(/\.[^.]+$/, "") || "Untitled",
			r2Key: key,
			url,
			contentType,
			sizeBytes: size || null,
		})
		.returning();
	return Response.json({ video: row });
});
