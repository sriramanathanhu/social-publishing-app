import type { NextRequest } from "next/server";
import { reconcileAllRunningShorts } from "@/lib/shorts-jobs";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/internal/sync-shorts — background tick (cron). Reconciles every
 * queued/running shorts job against the sidecar (status + clips) so the UI never
 * shows a stale "stuck/queued" and finished clips get persisted without anyone
 * opening /shorts. Token-gated. Replaces the host-only sync-shorts.mjs so the
 * containerized deploy can drive it as a plain curl like the other ticks.
 */
export async function POST(req: NextRequest) {
	const token = process.env.DUBBER_SERVICE_TOKEN ?? "";
	if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	const reconciled = await reconcileAllRunningShorts();
	return Response.json({ ok: true, reconciled });
}
