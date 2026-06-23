import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { shortsClips, shortsJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { deleteR2Object } from "@/lib/r2";
import { isAdmin } from "@/lib/rbac";
import { shorts } from "@/lib/shorts";
import { getOwnedShortsJob, persistClips } from "@/lib/shorts-jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/shorts/:id — current status + clips. Syncs from the sidecar and
 * persists the terminal state (and clips) so the row is accurate even if the
 * client never held an SSE connection open.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	let job = await getOwnedShortsJob(user, id);

	if (job.shortsJobId && job.status !== "done" && job.status !== "failed") {
		try {
			const remote = await shorts.getStatus(job.shortsJobId);
			const status =
				remote.status === "done"
					? "done"
					: remote.status === "failed"
						? "failed"
						: "running";
			if (status === "done") await persistClips(job.id, job.shortsJobId);
			const terminal = status === "done" || status === "failed";
			const [updated] = await db
				.update(shortsJobs)
				.set({
					status,
					pct: remote.pct,
					stage: remote.stage,
					message: remote.message,
					error: remote.error,
					completedAt: terminal ? new Date() : undefined,
					updatedAt: new Date(),
				})
				.where(eq(shortsJobs.id, job.id))
				.returning();
			job = updated;
		} catch {
			/* service unreachable — return last known state */
		}
	}

	const clips = await db
		.select()
		.from(shortsClips)
		.where(eq(shortsClips.jobId, id))
		.orderBy(shortsClips.idx);

	return Response.json({ job, clips });
});

/**
 * DELETE /api/shorts/:id — remove a whole shorts JOB and its clips (e.g. a run
 * that produced 0 usable clips). Owner OR admin. Clears each clip's R2 object,
 * then deletes the job row (clip rows cascade).
 */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;

	const job = await db.query.shortsJobs.findFirst({
		where: eq(shortsJobs.id, id),
	});
	if (!job) throw new HttpError(404, "Shorts job not found");
	if (job.userId !== user.id && !isAdmin(user)) {
		throw new HttpError(403, "You can only delete shorts you generated");
	}

	const clips = await db
		.select({ r2Key: shortsClips.r2Key })
		.from(shortsClips)
		.where(eq(shortsClips.jobId, id));
	for (const c of clips) {
		try {
			await deleteR2Object(c.r2Key);
		} catch {
			// Orphaned object is harmless; keep deleting.
		}
	}
	await db.delete(shortsJobs).where(eq(shortsJobs.id, id));
	return Response.json({ ok: true });
});
