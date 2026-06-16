import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { type AppUser, HttpError } from "@/lib/auth";

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
