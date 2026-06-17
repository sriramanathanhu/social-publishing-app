import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { shorts } from "@/lib/shorts";
import { getOwnedShortsJob } from "@/lib/shorts-jobs";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/shorts/:id/events — proxy the sidecar's SSE progress stream to the
 * browser after an ownership check, so the bearer token never reaches the client.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const job = await getOwnedShortsJob(user, id);

	if (!job.shortsJobId) {
		return new Response("event: failed\ndata: job not dispatched\n\n", {
			headers: { "Content-Type": "text/event-stream" },
		});
	}

	const upstream = await shorts.eventStream(job.shortsJobId);
	if (!upstream.ok || !upstream.body) {
		return new Response("event: failed\ndata: upstream unavailable\n\n", {
			headers: { "Content-Type": "text/event-stream" },
		});
	}

	return new Response(upstream.body, {
		headers: {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache, no-transform",
			Connection: "keep-alive",
		},
	});
});
