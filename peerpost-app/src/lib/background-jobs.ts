import "server-only";
import { and, asc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { backgroundJobs, users } from "@/db/schema";
import type { AppUser } from "@/lib/auth";
import {
	type AutoPublishQuotesInput,
	autoPublishQuotes,
} from "@/lib/quote-autopublish";
import { type DistributeInput, distributeQuotes } from "@/lib/quote-distribute";
import { autoScheduleText, type TextKind } from "@/lib/text-autopublish";

export type JobKind =
	| "quote-distribute"
	| "quote-autopublish"
	| "text-autopublish";

/** Postgres NOTIFY channel a worker LISTENs on to wake instantly on enqueue
 * (instead of waiting for the next poll). Safe to ignore — the claim loop is the
 * source of truth; NOTIFY is only a latency optimisation. */
export const JOBS_CHANNEL = "background_jobs";

/** A job is considered abandoned if its heartbeat is older than this — i.e. the
 * worker died mid-run. The cron's per-run cap is ~23 min, so 30 min cannot be a
 * still-running job under cron; persistent workers refresh the heartbeat (see
 * `heartbeat`) so a long job stays alive. */
const STALE_AFTER_MIN = 30;
/** Max times a job is re-queued before we give up (stops a poison job looping). */
const MAX_ATTEMPTS = 3;

/** Enqueue a long batch and wake any listening worker. Returns the id. */
export async function enqueueJob(
	userId: string,
	kind: JobKind,
	payload: Record<string, unknown>,
): Promise<string> {
	const [row] = await db
		.insert(backgroundJobs)
		.values({ userId, kind, payload })
		.returning({ id: backgroundJobs.id });
	// Best-effort wake; the claim loop still picks it up if no one is listening.
	try {
		await db.execute(sql`select pg_notify(${JOBS_CHANNEL}, ${row.id})`);
	} catch {
		/* NOTIFY is an optimisation only */
	}
	return row.id;
}

/** Refresh a running job's heartbeat — called periodically by long workers so
 * the reaper doesn't reclaim a job that's still being worked. */
export async function heartbeat(jobId: string): Promise<void> {
	await db
		.update(backgroundJobs)
		.set({ heartbeatAt: new Date() })
		.where(eq(backgroundJobs.id, jobId));
}

/**
 * Re-queue jobs abandoned by a dead worker: status="running" but heartbeat is
 * stale. Under the attempt cap they go back to "pending" (a worker re-claims
 * them); over the cap they're failed. Returns {requeued, failed}. Idempotent and
 * safe to run every tick.
 */
export async function reapStaleJobs(): Promise<{
	requeued: number;
	failed: number;
}> {
	const cutoff = new Date(Date.now() - STALE_AFTER_MIN * 60_000);
	const stale = await db
		.select({ id: backgroundJobs.id, attempts: backgroundJobs.attempts })
		.from(backgroundJobs)
		.where(
			and(
				eq(backgroundJobs.status, "running"),
				or(
					lt(backgroundJobs.heartbeatAt, cutoff),
					// Never heartbeated but started long ago (older claim shape).
					sql`${backgroundJobs.heartbeatAt} is null and ${backgroundJobs.startedAt} < ${cutoff}`,
				),
			),
		);

	let requeued = 0;
	let failed = 0;
	for (const job of stale) {
		if (job.attempts >= MAX_ATTEMPTS) {
			const [f] = await db
				.update(backgroundJobs)
				.set({
					status: "failed",
					error: `Abandoned by worker; gave up after ${MAX_ATTEMPTS} attempts`,
					finishedAt: new Date(),
				})
				.where(
					and(
						eq(backgroundJobs.id, job.id),
						eq(backgroundJobs.status, "running"),
					),
				)
				.returning({ id: backgroundJobs.id });
			if (f) failed++;
		} else {
			const [r] = await db
				.update(backgroundJobs)
				.set({ status: "pending", heartbeatAt: null, startedAt: null })
				.where(
					and(
						eq(backgroundJobs.id, job.id),
						eq(backgroundJobs.status, "running"),
					),
				)
				.returning({ id: backgroundJobs.id });
			if (r) requeued++;
		}
	}
	return { requeued, failed };
}

async function runOne(
	user: AppUser,
	kind: string,
	payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	if (kind === "quote-distribute")
		return await distributeQuotes(user, payload as unknown as DistributeInput);
	if (kind === "quote-autopublish")
		return await autoPublishQuotes(
			user,
			payload as unknown as AutoPublishQuotesInput,
		);
	if (kind === "text-autopublish")
		return await autoScheduleText(
			user,
			payload as unknown as {
				kind: TextKind;
				itemId: string;
				languages: string[];
			},
		);
	throw new Error(`unknown job kind: ${kind}`);
}

/**
 * Claim and run up to `limit` pending jobs (oldest first). Each is claimed
 * atomically (pending→running) so overlapping cron ticks never double-run one.
 * Runs in the cron's request scope, so cache()-backed helpers work normally.
 * Returns the number of jobs finished (done or failed) this pass.
 */
export async function runBackgroundJobs(limit = 1): Promise<number> {
	const pending = await db
		.select()
		.from(backgroundJobs)
		.where(eq(backgroundJobs.status, "pending"))
		.orderBy(asc(backgroundJobs.createdAt))
		.limit(limit);

	let processed = 0;
	for (const job of pending) {
		const [claimed] = await db
			.update(backgroundJobs)
			.set({
				status: "running",
				startedAt: new Date(),
				heartbeatAt: new Date(),
				attempts: sql`${backgroundJobs.attempts} + 1`,
			})
			.where(
				and(
					eq(backgroundJobs.id, job.id),
					eq(backgroundJobs.status, "pending"),
				),
			)
			.returning({ id: backgroundJobs.id });
		if (!claimed) continue; // someone else took it

		try {
			const user = await db.query.users.findFirst({
				where: eq(users.id, job.userId),
			});
			if (!user) throw new Error("job owner not found");
			const result = await runOne(user, job.kind, job.payload);
			await db
				.update(backgroundJobs)
				.set({ status: "done", result, finishedAt: new Date() })
				.where(eq(backgroundJobs.id, job.id));
		} catch (err) {
			await db
				.update(backgroundJobs)
				.set({
					status: "failed",
					error: err instanceof Error ? err.message : String(err),
					finishedAt: new Date(),
				})
				.where(eq(backgroundJobs.id, job.id));
		}
		processed++;
	}
	return processed;
}
