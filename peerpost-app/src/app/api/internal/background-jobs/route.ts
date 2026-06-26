import type { NextRequest } from "next/server";
import { runBackgroundJobs } from "@/lib/background-jobs";

export const runtime = "nodejs";
export const maxDuration = 1500;

/**
 * POST /api/internal/background-jobs — claims and runs one queued batch
 * (quote distribute / auto-publish / text auto-publish). Driven by a minute-ly
 * cron under flock, so jobs run one at a time to completion. Token-gated.
 */
export async function POST(req: NextRequest) {
	const token = process.env.DUBBER_SERVICE_TOKEN ?? "";
	if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	const processed = await runBackgroundJobs(1);
	return Response.json({ ok: true, processed });
}
