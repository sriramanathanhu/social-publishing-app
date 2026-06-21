import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { archiveDoneJob, getOwnedJob } from "@/lib/dub-jobs";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";
import { deleteR2Object } from "@/lib/r2";
import { isAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/dub/:id — current status. Syncs the latest progress from the
 * dubber-service and persists it, so the row is accurate even if the client
 * never held an SSE connection open.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const job = await getOwnedJob(user, id);

	// Terminal or never-dispatched jobs don't need a remote poll.
	if (!job.dubberJobId || job.status === "done" || job.status === "failed") {
		return Response.json({ job });
	}

	try {
		const remote = await dubber.getStatus(job.dubberJobId);
		const status =
			remote.status === "done"
				? "done"
				: remote.status === "failed"
					? "failed"
					: "running";

		// On completion, pull the AI captions once and cache them on the row.
		let captions = job.captions;
		if (status === "done" && !captions) {
			try {
				captions = await dubber.getCaptions(job.dubberJobId);
			} catch {
				// Captions are best-effort; leave null and let publishing proceed.
			}
		}

		const [updated] = await db
			.update(dubJobs)
			.set({
				status,
				pct: remote.pct,
				stage: remote.stage,
				message: remote.message,
				error: remote.error,
				captions,
				updatedAt: new Date(),
			})
			.where(eq(dubJobs.id, job.id))
			.returning();
		// Durably archive the finished dub to R2 (best-effort backup).
		if (updated?.status === "done") {
			try {
				await archiveDoneJob(updated);
			} catch {
				// Non-fatal: a later status poll / page load retries.
			}
		}
		return Response.json({ job: updated });
	} catch {
		// Service unreachable — return the last known state rather than erroring.
		return Response.json({ job });
	}
});

/**
 * DELETE /api/dub/:id — remove a generated dub. Allowed for the job's owner OR
 * an admin (admins can delete anyone's; users only their own). Drops the R2
 * archive (best-effort) and the DB row.
 */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;

	const job = await db.query.dubJobs.findFirst({ where: eq(dubJobs.id, id) });
	if (!job) throw new HttpError(404, "Dub not found");
	if (job.userId !== user.id && !isAdmin(user)) {
		throw new HttpError(403, "You can only delete dubs you generated");
	}

	try {
		await deleteR2Object(job.archiveKey);
	} catch {
		// Orphaned object is harmless; proceed with the row delete.
	}
	await db.delete(dubJobs).where(eq(dubJobs.id, id));
	return Response.json({ ok: true });
});
