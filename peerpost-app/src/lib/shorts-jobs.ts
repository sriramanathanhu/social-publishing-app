import { and, eq, inArray } from "drizzle-orm";
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
	await db.delete(shortsClips).where(eq(shortsClips.jobId, jobId));
	await db.insert(shortsClips).values(
		clips.map((c) => ({
			jobId,
			idx: c.idx,
			title: c.youtube_title ?? c.title ?? null,
			description: c.youtube_description ?? null,
			hashtags: c.hashtags ?? null,
			startSec: c.start_seconds ?? null,
			endSec: c.end_seconds ?? null,
			durationSec: c.duration ?? null,
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
	const open = await db
		.select()
		.from(shortsJobs)
		.where(
			and(
				eq(shortsJobs.userId, userId),
				inArray(shortsJobs.status, ["queued", "running"]),
			),
		);

	let updated = 0;
	for (const job of open) {
		if (!job.shortsJobId) continue;
		try {
			const remote = await shorts.getStatus(job.shortsJobId);
			if (remote.status !== "done" && remote.status !== "failed") continue;
			if (remote.status === "done") {
				await persistClips(job.id, job.shortsJobId);
			}
			await db
				.update(shortsJobs)
				.set({
					status: remote.status,
					pct: remote.pct,
					stage: remote.stage,
					message: remote.message,
					error: remote.error,
					updatedAt: new Date(),
				})
				.where(eq(shortsJobs.id, job.id));
			updated++;
		} catch {
			/* service unreachable — leave for next load */
		}
	}
	return updated;
}
