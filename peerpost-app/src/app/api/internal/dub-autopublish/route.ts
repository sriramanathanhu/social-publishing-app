import type { NextRequest } from "next/server";
import { runDubAutopublish } from "@/lib/dub-autopublish";
import { reconcileAllRunningDubs } from "@/lib/dub-jobs";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/internal/dub-autopublish — background tick (cron). Reconciles
 * running dubs against the sidecar (so unattended ones reach "done" + archive),
 * then auto-schedules any opted-in finished dubs to their language's accounts.
 * Gated by the shared service token, like the dubber endpoints.
 */
export async function POST(req: NextRequest) {
	const token = process.env.DUBBER_SERVICE_TOKEN ?? "";
	if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	const reconciled = await reconcileAllRunningDubs();
	const published = await runDubAutopublish();
	return Response.json({ ok: true, reconciled, published });
}
