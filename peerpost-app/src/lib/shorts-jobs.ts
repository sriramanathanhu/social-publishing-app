import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { shortsClips, shortsJobs } from "@/db/schema";
import { type AppUser, HttpError } from "@/lib/auth";
import { shorts } from "@/lib/shorts";

export type ShortsJob = typeof shortsJobs.$inferSelect;

/** Load a shorts job, asserting it belongs to the requesting user. */
export async function getOwnedShortsJob(
	user: AppUser,
	jobId: string,
): Promise<ShortsJob> {
	const job = await db.query.shortsJobs.findFirst({
		where: and(eq(shortsJobs.id, jobId), eq(shortsJobs.userId, user.id)),
	});
	if (!job) throw new HttpError(404, "Shorts job not found");
	return job;
}

/**
 * Persist a finished job's clips into shorts_clips (idempotent — clears and
 * re-inserts). Called when a job transitions to done.
 */
export async function persistClips(jobId: string, shortsJobId: string) {
	const clips = await shorts.getClips(shortsJobId);
	if (clips.length === 0) return;
	// start/end can be fractional seconds (word-level cut precision); the
	// columns are integer (display only — the render already used the exact
	// values), so round to avoid a Postgres "invalid input for integer" that
	// would otherwise abort persistence and leave the job stuck "running".
	const sec = (v: number | null | undefined) =>
		v == null ? null : Math.round(v);
	await db.delete(shortsClips).where(eq(shortsClips.jobId, jobId));
	await db.insert(shortsClips).values(
		clips.map((c) => ({
			jobId,
			idx: c.idx,
			title: c.youtube_title ?? c.title ?? null,
			description: c.youtube_description ?? null,
			hashtags: c.hashtags ?? null,
			startSec: sec(c.start_seconds),
			endSec: sec(c.end_seconds),
			durationSec: sec(c.duration),
			viralScore: c.viral_score ?? null,
			r2Key: c.r2_key ?? null,
			publicUrl: c.public_url ?? null,
		})),
	);
}

/**
 * Reconcile a user's still-running shorts jobs against the sidecar and persist
 * terminal transitions (status + clips). Mirrors dub reconcileRunningJobs:
 * the SSE proxy only streams to the browser, so a job that finished with no tab
 * open would otherwise stay "running". Best-effort. Returns rows updated.
 */
export async function reconcileRunningShorts(userId: string): Promise<number> {
	// Capped + parallel + time-bounded (shorts.getStatus has a 5s timeout) so a
	// busy sidecar can't stall the page even with many open jobs.
	const open = await db
		.select()
		.from(shortsJobs)
		.where(
			and(
				eq(shortsJobs.userId, userId),
				inArray(shortsJobs.status, ["queued", "running"]),
			),
		)
		.orderBy(desc(shortsJobs.createdAt))
		.limit(40);

	const results = await Promise.all(
		open.map(async (job) => {
			if (!job.shortsJobId) return 0;
			try {
				const remote = await shorts.getStatus(job.shortsJobId);
				// Reflect the sidecar's real state — including queued↔running, so a
				// parked job shows "queued" instead of a misleading "running".
				const status =
					remote.status === "done"
						? "done"
						: remote.status === "failed"
							? "failed"
							: remote.status === "queued"
								? "queued"
								: "running";
				const terminal = status === "done" || status === "failed";
				if (status === job.status && !terminal) return 0; // unchanged
				if (status === "done") await persistClips(job.id, job.shortsJobId);
				await db
					.update(shortsJobs)
					.set({
						status,
						pct: remote.pct,
						stage: remote.stage,
						message: remote.message,
						error: remote.error,
						...(terminal ? { completedAt: new Date() } : {}),
						updatedAt: new Date(),
					})
					.where(eq(shortsJobs.id, job.id));
				return 1;
			} catch {
				/* unreachable/slow — leave for next load */
				return 0;
			}
		}),
	);
	return results.filter(Boolean).length;
}

/**
 * Global (all-users) reconcile of queued/running shorts jobs against the sidecar,
 * persisting clips for finished ones. For the background cron, so unattended jobs
 * reach "done"/"failed" without anyone opening /shorts. Mirrors the dub
 * reconcileAllRunningDubs. Returns the number of rows updated.
 */
export async function reconcileAllRunningShorts(limit = 60): Promise<number> {
	const open = await db
		.select()
		.from(shortsJobs)
		.where(inArray(shortsJobs.status, ["queued", "running"]))
		.orderBy(desc(shortsJobs.createdAt))
		.limit(limit);

	const results = await Promise.all(
		open.map(async (job) => {
			if (!job.shortsJobId) return 0;
			try {
				const remote = await shorts.getStatus(job.shortsJobId);
				const status =
					remote.status === "done"
						? "done"
						: remote.status === "failed"
							? "failed"
							: remote.status === "queued"
								? "queued"
								: "running";
				const terminal = status === "done" || status === "failed";
				if (status === job.status && !terminal) return 0;
				if (status === "done") await persistClips(job.id, job.shortsJobId);
				await db
					.update(shortsJobs)
					.set({
						status,
						pct: remote.pct,
						stage: remote.stage,
						message: remote.message,
						error: remote.error,
						...(terminal ? { completedAt: new Date() } : {}),
						updatedAt: new Date(),
					})
					.where(eq(shortsJobs.id, job.id));
				return 1;
			} catch {
				/* unreachable/slow — leave for next tick */
				return 0;
			}
		}),
	);
	return results.filter(Boolean).length;
}
