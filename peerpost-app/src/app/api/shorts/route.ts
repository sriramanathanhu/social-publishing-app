import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { shortsJobs } from "@/db/schema";
import { getUserCookies, getUserKeys } from "@/lib/api-keys";
import { getUserAssets } from "@/lib/assets";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { isApproved } from "@/lib/rbac";
import { shorts } from "@/lib/shorts";

export const runtime = "nodejs";

/** GET /api/shorts — the current user's shorts jobs (most recent first). */
export const GET = route(async () => {
	const user = await requireUser();
	const jobs = await db
		.select()
		.from(shortsJobs)
		.where(eq(shortsJobs.userId, user.id))
		.orderBy(desc(shortsJobs.createdAt));
	return Response.json({ jobs });
});

const createSchema = z.object({
	sourceType: z.enum(["url", "upload"]).default("url"),
	sourceInput: z.string().url(),
	numClips: z.number().int().min(1).max(30).default(15),
	minSeconds: z.number().int().min(10).max(600).default(90),
	maxSeconds: z.number().int().min(15).max(900).default(120),
	aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
	language: z.string().min(2).max(8).default("en"),
	captions: z.boolean().default(true),
});

/**
 * POST /api/shorts — start a "long video → shorts" job.
 *
 * Needs an approved user with Deepgram (transcription) + NVIDIA (clip-finding /
 * titles) keys. Keys are decrypted server-side and passed per job; URL sources
 * also get the user's yt-dlp cookies for login/rate-limited platforms.
 */
export const POST = route(async (request: NextRequest) => {
	const user = await requireUser();
	if (!isApproved(user)) throw new HttpError(403, "Awaiting approval");

	const input = createSchema.parse(await request.json());

	const keys = await getUserKeys(user.id);
	if (!keys.deepgram)
		throw new HttpError(400, "Add your Deepgram API key in Settings first");
	if (!keys.nvidia)
		throw new HttpError(400, "Add your NVIDIA API key in Settings first");

	const cookies =
		input.sourceType === "url"
			? ((await getUserCookies(user.id)) ?? undefined)
			: undefined;
	const assets = await getUserAssets(user.id);

	const [job] = await db
		.insert(shortsJobs)
		.values({
			userId: user.id,
			status: "queued",
			sourceType: input.sourceType,
			sourceInput: input.sourceInput,
			numClips: input.numClips,
			settings: {
				minSeconds: input.minSeconds,
				maxSeconds: input.maxSeconds,
				aspect: input.aspect,
				language: input.language,
			},
		})
		.returning();

	try {
		const { job_id } = await shorts.createJob({
			video_input: input.sourceInput,
			deepgram_key: keys.deepgram,
			nvidia_key: keys.nvidia,
			source_type: input.sourceType,
			cookies,
			num_clips: input.numClips,
			min_seconds: input.minSeconds,
			max_seconds: input.maxSeconds,
			aspect: input.aspect,
			language: input.language,
			captions: input.captions,
			overlay_url: assets.overlay ?? undefined,
			transition_url: assets.transition ?? undefined,
			endcard_url: assets.endcard ?? undefined,
		});

		const [updated] = await db
			.update(shortsJobs)
			.set({ shortsJobId: job_id, status: "running", updatedAt: new Date() })
			.where(eq(shortsJobs.id, job.id))
			.returning();
		return Response.json({ job: updated }, { status: 201 });
	} catch (err) {
		await db
			.update(shortsJobs)
			.set({
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				updatedAt: new Date(),
			})
			.where(eq(shortsJobs.id, job.id));
		throw err;
	}
});
