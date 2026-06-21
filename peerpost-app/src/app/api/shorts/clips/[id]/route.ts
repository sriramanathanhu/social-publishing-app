import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { shortsClips, shortsJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { deleteR2Object } from "@/lib/r2";
import { isAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/shorts/clips/:id — remove a single generated short (one reel).
 * Allowed for the parent job's owner OR an admin (users delete only their own).
 * Drops the R2 object (best-effort) and the clip row.
 */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;

	const [row] = await db
		.select({
			clipId: shortsClips.id,
			r2Key: shortsClips.r2Key,
			ownerId: shortsJobs.userId,
		})
		.from(shortsClips)
		.innerJoin(shortsJobs, eq(shortsClips.jobId, shortsJobs.id))
		.where(eq(shortsClips.id, id))
		.limit(1);
	if (!row) throw new HttpError(404, "Clip not found");
	if (row.ownerId !== user.id && !isAdmin(user)) {
		throw new HttpError(403, "You can only delete clips you generated");
	}

	try {
		await deleteR2Object(row.r2Key);
	} catch {
		// Orphaned object is harmless; proceed with the row delete.
	}
	await db.delete(shortsClips).where(eq(shortsClips.id, id));
	return Response.json({ ok: true });
});
