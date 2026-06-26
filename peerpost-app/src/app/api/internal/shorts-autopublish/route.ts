import type { NextRequest } from "next/server";
import { runShortsAutopublish } from "@/lib/shorts-autopublish";

export const runtime = "nodejs";
export const maxDuration = 120;

/**
 * POST /api/internal/shorts-autopublish — background tick (cron). Schedules any
 * newly-finished clips of auto-publish-opted shorts jobs into their distribution
 * list (a slice per ecosystem, drip-spaced). Clip syncing is done by the
 * sync-shorts cron; this only schedules clips that already have a public URL.
 * Gated by the shared service token.
 */
export async function POST(req: NextRequest) {
	const token = process.env.DUBBER_SERVICE_TOKEN ?? "";
	if (!token || req.headers.get("authorization") !== `Bearer ${token}`) {
		return new Response("Unauthorized", { status: 401 });
	}
	const published = await runShortsAutopublish();
	return Response.json({ ok: true, published });
}
