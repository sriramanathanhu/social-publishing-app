import type { NextRequest } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { getOwnedJob } from "@/lib/dub-jobs";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/dub/:id/result — stream the finished dubbed mp4 to the owner.
 *
 * Phase 2 will instead push this into the PostPeer media-upload flow and hand
 * the publicUrl to the composer; for the skeleton it's a direct download.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const job = await getOwnedJob(user, id);

	if (job.status !== "done" || !job.dubberJobId) {
		throw new HttpError(409, "Dub is not finished yet");
	}

	const upstream = await dubber.result(job.dubberJobId);
	if (!upstream.ok || !upstream.body) {
		throw new HttpError(502, "Could not fetch the dubbed video");
	}

	return new Response(upstream.body, {
		headers: {
			"Content-Type": "video/mp4",
			"Content-Disposition": `attachment; filename="dubbed-${id}.mp4"`,
		},
	});
});
