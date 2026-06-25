import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { type AppUser, HttpError } from "@/lib/auth";
import { dubber } from "@/lib/dubber";
import { archiveDubVideo, r2Enabled } from "@/lib/r2";

export type DubJob = typeof dubJobs.$inferSelect;

/**
 * Durably archive a finished dub to R2 (backup only — does not affect
 * publishing). Idempotent: skips if already archived or R2 isn't configured.
 * Best-effort — the caller treats any failure as non-fatal so a storage hiccup
 * never blocks download/publish. Returns the object key when one is set.
 */
export async function archiveDoneJob(job: DubJob): Promise<string | null> {
	if (job.archiveKey) return job.archiveKey;
	if (!job.dubberJobId || !r2Enabled()) return null;
	const upstream = await dubber.result(job.dubberJobId);
	if (!upstream.ok || !upstream.body) return null;
	const key = await archiveDubVideo(job.id, await upstream.arrayBuffer());
	if (!key) return null;
	await db
		.update(dubJobs)
		.set({ archiveKey: key, updatedAt: new Date() })
		.where(eq(dubJobs.id, job.id));
	return key;
}

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
/** Sync one running dub against the sidecar; archive on completion. Returns 1
 * if a terminal transition was persisted. Time-bounded (getStatus has a 5s cap). */
async function reconcileOneDub(job: DubJob): Promise<number> {
	if (!job.dubberJobId) return 0;
	try {
		const remote = await dubber.getStatus(job.dubberJobId);
		if (remote.status !== "done" && remote.status !== "failed") return 0;
		let captions = job.captions;
		if (remote.status === "done" && !captions) {
			try {
				captions = await dubber.getCaptions(job.dubberJobId);
			} catch {
				/* captions best-effort */
			}
		}
		const [fresh] = await db
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
			.where(eq(dubJobs.id, job.id))
			.returning();
		if (fresh?.status === "done") {
			try {
				await archiveDoneJob(fresh);
			} catch {
				/* storage hiccup — retried on next load */
			}
		}
		return 1;
	} catch {
		/* unreachable/slow — leave for next load */
		return 0;
	}
}

export async function reconcileRunningJobs(userId: string): Promise<number> {
	// Only "running" jobs can have finished while no tab was open. Skipping
	// "queued" avoids hammering the sidecar with status calls for jobs that
	// aren't processing (e.g. a large paused batch), which used to hang the page.
	// Capped + run in parallel + time-bounded so a busy sidecar can't stall it.
	const open = await db
		.select()
		.from(dubJobs)
		.where(and(eq(dubJobs.userId, userId), eq(dubJobs.status, "running")))
		.orderBy(desc(dubJobs.createdAt))
		.limit(40);
	const results = await Promise.all(open.map(reconcileOneDub));
	return results.filter(Boolean).length;
}

/** Global (all users) reconcile of running dubs — for the background cron, so
 * unattended dubs reach "done" (and archive) without anyone opening /dub. */
export async function reconcileAllRunningDubs(limit = 60): Promise<number> {
	const open = await db
		.select()
		.from(dubJobs)
		.where(eq(dubJobs.status, "running"))
		.orderBy(desc(dubJobs.createdAt))
		.limit(limit);
	const results = await Promise.all(open.map(reconcileOneDub));
	return results.filter(Boolean).length;
}
