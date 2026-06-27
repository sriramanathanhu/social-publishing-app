import { and, eq, like } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { redispatchDub } from "@/lib/dub-jobs";

export const runtime = "nodejs";
export const maxDuration = 300;

/** Marker written by reconcileOneDub when the sidecar 404s an in-flight job. */
const ORPHAN_MARKER = "Dub worker lost this job%";

/**
 * POST /api/internal/dub-redispatch-orphans — recover dubs orphaned by a sidecar
 * restart (status=failed with the "worker lost this job" marker) by re-dispatching
 * them with their stored parameters. Token-gated like the other internal routes.
 * Idempotent-ish: only picks up rows still in the failed-orphan state, and each
 * re-dispatch flips the row to running so a second call won't double-submit.
 */
export async function POST(req: NextRequest) {
	const token = process.env.DUBBER_SERVICE_TOKEN ?? "";
	if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}

	const orphans = await db
		.select()
		.from(dubJobs)
		.where(and(eq(dubJobs.status, "failed"), like(dubJobs.error, ORPHAN_MARKER)));

	let redispatched = 0;
	const failures: { id: string; error: string }[] = [];
	// Sequential, not parallel: the sidecar pool is small (2) and a burst of 71
	// createJob calls would just queue anyway; sequential keeps it gentle and
	// lets a bad key fail fast without firing the rest.
	for (const job of orphans) {
		try {
			await redispatchDub(job);
			redispatched++;
		} catch (err) {
			failures.push({
				id: job.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return Response.json({
		ok: true,
		found: orphans.length,
		redispatched,
		failures,
	});
}
