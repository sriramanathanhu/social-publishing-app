import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { shortsClips, shortsJobs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
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
			const [updated] = await db
				.update(shortsJobs)
				.set({
					status,
					pct: remote.pct,
					stage: remote.stage,
					message: remote.message,
					error: remote.error,
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
