import "server-only";
import { and, asc, eq } from "drizzle-orm";
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

/** Enqueue a long batch; the cron processor runs it shortly. Returns the id. */
export async function enqueueJob(
	userId: string,
	kind: JobKind,
	payload: Record<string, unknown>,
): Promise<string> {
	const [row] = await db
		.insert(backgroundJobs)
		.values({ userId, kind, payload })
		.returning({ id: backgroundJobs.id });
	return row.id;
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
			.set({ status: "running", startedAt: new Date() })
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
