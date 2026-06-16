import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { getOwnedJob } from "@/lib/dub-jobs";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/dub/:id/events — proxy the dubber-service SSE progress stream to the
 * browser after an ownership check. We pipe the upstream body straight through
 * so the bearer token never reaches the client.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const job = await getOwnedJob(user, id);

	if (!job.dubberJobId) {
		return new Response("event: failed\ndata: job not dispatched\n\n", {
			headers: { "Content-Type": "text/event-stream" },
		});
	}

	const upstream = await dubber.eventStream(job.dubberJobId);
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
