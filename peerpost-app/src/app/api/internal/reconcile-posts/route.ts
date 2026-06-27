import type { NextRequest } from "next/server";
import { reconcileScheduledZernioPosts } from "@/lib/zernio-reconcile";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * POST /api/internal/reconcile-posts — pull the real status of "scheduled" Zernio
 * posts and advance the terminal ones (published / failed / gone). One batch per
 * call; loop until `remaining` is 0 for the one-off backfill, or run on a cron as
 * a safety-net behind the webhook. Token-gated like the other internal routes.
 *
 * Query: ?limit=N (batch size, default 200) &concurrency=N (default 8)
 *        &overdue=1 (only posts past their scheduled time — cron mode)
 */
export async function POST(req: NextRequest) {
	const token = process.env.DUBBER_SERVICE_TOKEN ?? "";
	if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	const sp = req.nextUrl.searchParams;
	const limit = Math.min(Number(sp.get("limit")) || 200, 500);
	const concurrency = Number(sp.get("concurrency")) || 8;
	const onlyOverdue = sp.get("overdue") === "1";

	const summary = await reconcileScheduledZernioPosts({
		limit,
		concurrency,
		onlyOverdue,
	});
	return Response.json({ ok: true, ...summary });
}
