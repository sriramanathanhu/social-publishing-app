import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { getOwnedJob } from "@/lib/dub-jobs";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";
import { uploadBufferToPostPeer } from "@/lib/media";
import { r2PublicUrl } from "@/lib/r2";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/dub/:id/export — move a finished dub into PostPeer media storage so
 * it can be published. Fetches the mp4 from the dubber-service, uploads it via
 * the shared PostPeer media flow, and records the publicUrl on the job.
 *
 * Idempotent: if the job already has an outputUrl, that URL is returned without
 * re-uploading. The composer then consumes this URL as a pre-attached video.
 */
export const POST = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const job = await getOwnedJob(user, id);

	if (job.outputUrl) {
		return Response.json({ publicUrl: job.outputUrl, type: "video" });
	}
	if (job.status !== "done" || !job.dubberJobId) {
		throw new HttpError(409, "Dub is not finished yet");
	}

	// Ensure AI captions are cached on the row so the composer can pre-fill them.
	let captions = job.captions;
	if (!captions) {
		try {
			captions = await dubber.getCaptions(job.dubberJobId);
		} catch {
			// Best-effort — publishing proceeds without captions.
		}
	}

	// Prefer the already-public R2 archive: providers fetch the video by URL, so
	// there's no need to download the (large) file and re-host it through our
	// server — that round-trip is what was timing out the gateway (502). The dub
	// preview already plays from this URL, so it's provider-fetchable.
	const r2Url = r2PublicUrl(job.archiveKey);
	if (r2Url) {
		await db
			.update(dubJobs)
			.set({ outputUrl: r2Url, captions, updatedAt: new Date() })
			.where(eq(dubJobs.id, job.id));
		return Response.json({ publicUrl: r2Url, type: "video" });
	}

	// Fallback (no R2 archive): re-host the mp4 from the dubber-service.
	const upstream = await dubber.result(job.dubberJobId);
	if (!upstream.ok || !upstream.body) {
		throw new HttpError(502, "Could not fetch the dubbed video");
	}
	const { publicUrl, type } = await uploadBufferToPostPeer(
		await upstream.arrayBuffer(),
		`dubbed-${id}.mp4`,
		"video/mp4",
	);
	await db
		.update(dubJobs)
		.set({ outputUrl: publicUrl, captions, updatedAt: new Date() })
		.where(eq(dubJobs.id, job.id));

	return Response.json({ publicUrl, type });
});
