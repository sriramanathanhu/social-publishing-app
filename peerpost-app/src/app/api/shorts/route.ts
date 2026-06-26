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
	name: z.string().max(120).optional(),
	sourceType: z.enum(["url", "upload"]).default("url"),
	sourceInput: z.string().url(),
	// 0 = AUTO (let the AI decide how many complete clips the video yields).
	numClips: z.number().int().min(0).max(50).default(3),
	// Opt-in: spread this job's clips into a saved shorts distribution list.
	autoPublishDistributionId: z.string().uuid().optional(),
	minSeconds: z.number().int().min(10).max(600).default(90),
	maxSeconds: z.number().int().min(15).max(900).default(120),
	aspect: z.enum(["9:16", "1:1", "16:9"]).default("9:16"),
	// "auto" = face-centered crop (default). center/left/right are manual biases.
	cropFocus: z.enum(["auto", "center", "left", "right"]).default("auto"),
	// Optional reference-face image (a public URL from /api/media/upload). When
	// set with cropFocus="auto", the reframer locks onto this specific person.
	referenceFaceUrl: z.string().url().optional(),
	// Final playback speed of each clip (e.g. 1.4 = 1.4x faster).
	speed: z.number().min(0.5).max(3).default(1),
	language: z.string().min(2).max(8).default("en"),
	captions: z.boolean().default(true),
	// "nim" = text selection (default; best for static talking-head). "gemini" =
	// visual selection (needs a Gemini key), only worth it for dynamic footage.
	selector: z.enum(["gemini", "nim"]).default("nim"),
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
	// Clip selection + titles use Gemini (preferred) OR NVIDIA NIM as fallback —
	// at least one is required.
	if (!keys.gemini && !keys.nvidia)
		throw new HttpError(
			400,
			"Add a Gemini API key (recommended) or an NVIDIA API key in Settings first",
		);

	const cookies =
		input.sourceType === "url"
			? ((await getUserCookies(user.id)) ?? undefined)
			: undefined;
	const assets = await getUserAssets(user.id);

	const [job] = await db
		.insert(shortsJobs)
		.values({
			userId: user.id,
			name: input.name?.trim() || null,
			status: "queued",
			sourceType: input.sourceType,
			sourceInput: input.sourceInput,
			numClips: input.numClips,
			autoPublishDistributionId: input.autoPublishDistributionId ?? null,
			settings: {
				minSeconds: input.minSeconds,
				maxSeconds: input.maxSeconds,
				aspect: input.aspect,
				language: input.language,
				// Audit only — the live value travels as a top-level field below.
				referenceFaceUrl: input.referenceFaceUrl ?? null,
			},
		})
		.returning();

	try {
		const { job_id } = await shorts.createJob({
			video_input: input.sourceInput,
			deepgram_key: keys.deepgram,
			nvidia_key: keys.nvidia ?? "",
			source_type: input.sourceType,
			cookies,
			num_clips: input.numClips,
			min_seconds: input.minSeconds,
			max_seconds: input.maxSeconds,
			aspect: input.aspect,
			crop_focus: input.cropFocus,
			reference_face_url:
				input.cropFocus === "auto" ? input.referenceFaceUrl : undefined,
			speed: input.speed,
			language: input.language,
			captions: input.captions,
			// Gemini visual selection when the user picked it AND has a key;
			// the sidecar falls back to the text model otherwise.
			selector: input.selector,
			gemini_key: keys.gemini ?? undefined,
			media_resolution: "low",
			overlay_url: assets.overlay ?? undefined,
			transition_url: assets.transition ?? undefined,
			endcard_url: assets.endcard ?? undefined,
		});

		const [updated] = await db
			.update(shortsJobs)
			// "queued" until the sidecar's pool actually starts it (it parks on a
			// slot); the status sync flips it to "running" when work begins.
			.set({ shortsJobId: job_id, status: "queued", updatedAt: new Date() })
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
