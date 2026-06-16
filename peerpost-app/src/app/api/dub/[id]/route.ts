import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { getOwnedJob } from "@/lib/dub-jobs";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";

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
		return Response.json({ job: updated });
	} catch {
		// Service unreachable — return the last known state rather than erroring.
		return Response.json({ job });
	}
});
