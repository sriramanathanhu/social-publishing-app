import type { NextRequest } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { eq } from "drizzle-orm";
import { HttpError, requireUser } from "@/lib/auth";
import { getOwnedJob, redispatchDub } from "@/lib/dub-jobs";
import { route } from "@/lib/http";
import { isApproved } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/dub/:id/retry — re-run a dub that failed or was orphaned (e.g. the
 * worker restarted and lost the job). Re-dispatches with the row's stored
 * parameters and resets it to "running". Only the owner (approved) can retry,
 * and only a terminal/stuck job — not one actively in flight.
 */
export const POST = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	if (!isApproved(user)) throw new HttpError(403, "Awaiting approval");
	const { id } = await params;
	const job = await getOwnedJob(user, id);

	if (job.status === "queued" || job.status === "running") {
		throw new HttpError(409, "This dub is already in progress");
	}

	try {
		const updated = await redispatchDub(job);
		return Response.json({ job: updated }, { status: 201 });
	} catch (err) {
		await db
			.update(dubJobs)
			.set({
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				updatedAt: new Date(),
			})
			.where(eq(dubJobs.id, job.id));
		throw err;
	}
});
