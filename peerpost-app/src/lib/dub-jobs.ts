import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { type AppUser, HttpError } from "@/lib/auth";
import { dubber } from "@/lib/dubber";

export type DubJob = typeof dubJobs.$inferSelect;

/** Load a dub job, asserting it belongs to the requesting user. */
export async function getOwnedJob(
	user: AppUser,
	jobId: string,
): Promise<DubJob> {
	const job = await db.query.dubJobs.findFirst({
		where: and(eq(dubJobs.id, jobId), eq(dubJobs.userId, user.id)),
	});
	// 404 (not 403) so we don't leak existence of other users' jobs.
	if (!job) throw new HttpError(404, "Dub job not found");
	return job;
}

/**
 * Reconcile a user's still-running jobs against the dubber-service and persist
 * any terminal transitions. The SSE proxy only streams to the browser, so a job
 * that finished while no tab was open would otherwise stay "running" forever —
 * leaving its result/export blocked. Best-effort: an unreachable service is
 * ignored. Returns the number of rows updated.
 */
export async function reconcileRunningJobs(userId: string): Promise<number> {
	const open = await db
		.select()
		.from(dubJobs)
		.where(
			and(
				eq(dubJobs.userId, userId),
				inArray(dubJobs.status, ["queued", "running"]),
			),
		);

	let updated = 0;
	for (const job of open) {
		if (!job.dubberJobId) continue;
		try {
			const remote = await dubber.getStatus(job.dubberJobId);
			if (remote.status !== "done" && remote.status !== "failed") continue;
			let captions = job.captions;
			if (remote.status === "done" && !captions) {
				try {
					captions = await dubber.getCaptions(job.dubberJobId);
				} catch {
					/* captions best-effort */
				}
			}
			await db
				.update(dubJobs)
				.set({
					status: remote.status,
					pct: remote.pct,
					stage: remote.stage,
					message: remote.message,
					error: remote.error,
					captions,
					updatedAt: new Date(),
				})
				.where(eq(dubJobs.id, job.id));
			updated++;
		} catch {
			/* service unreachable — leave the row as-is for the next load */
		}
	}
	return updated;
}
