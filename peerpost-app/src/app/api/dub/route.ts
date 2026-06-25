import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { getUserCookies, getUserKeys } from "@/lib/api-keys";
import { HttpError, requireUser } from "@/lib/auth";
import { DUB_LANGUAGE_CODES, DUB_VOICE_IDS } from "@/lib/dub-options";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";
import { isApproved } from "@/lib/rbac";

export const runtime = "nodejs";

/** GET /api/dub — the current user's dub jobs (most recent first). */
export const GET = route(async () => {
	const user = await requireUser();
	const jobs = await db
		.select()
		.from(dubJobs)
		.where(eq(dubJobs.userId, user.id))
		.orderBy(desc(dubJobs.createdAt));
	return Response.json({ jobs });
});

const createSchema = z.object({
	// "url": yt-dlp extracts the source (YouTube/Instagram/Drive/...).
	// "upload": sourceInput is a public URL we host (the local file the user
	// uploaded, already pushed to PostPeer media) — fetched directly, no cookies.
	sourceType: z.enum(["url", "upload"]).default("url"),
	sourceInput: z.string().url(),
	sourceLang: z.string().min(2).max(8).default("auto"),
	targetLang: z.enum(DUB_LANGUAGE_CODES as [string, ...string[]]),
	voice: z.enum(DUB_VOICE_IDS as [string, ...string[]]),
	// When dubbing a Library item, link back to it (for the "Dubbed" tag).
	sourceLibraryId: z.string().max(64).optional(),
	sourceLibraryKind: z.enum(["upload", "short"]).optional(),
	// Burn the translated captions (subtitles) into the dubbed video.
	burnCaptions: z.boolean().default(false),
	// Auto-publish: ecosystem whose language→account rules apply on completion.
	autoPublishProfileId: z.string().uuid().optional(),
});

/**
 * POST /api/dub — start a dubbing job.
 *
 * Requires an approved user and a stored Deepgram key (transcription) plus a
 * Gemini key (translation). Keys are decrypted server-side and passed to the
 * dubber-service per job; they are never sent to the browser or logged.
 */
export const POST = route(async (request: NextRequest) => {
	const user = await requireUser();
	if (!isApproved(user)) {
		throw new HttpError(403, "Awaiting approval");
	}

	const input = createSchema.parse(await request.json());

	const keys = await getUserKeys(user.id);
	if (!keys.deepgram) {
		throw new HttpError(400, "Add your Deepgram API key in Settings first");
	}
	if (!keys.gemini) {
		throw new HttpError(400, "Add your Gemini API key in Settings first");
	}

	// Record the job before dispatch so a failed dispatch is still auditable.
	const [job] = await db
		.insert(dubJobs)
		.values({
			userId: user.id,
			status: "queued",
			sourceType: input.sourceType,
			sourceInput: input.sourceInput,
			sourceLang: input.sourceLang,
			targetLang: input.targetLang,
			voice: input.voice,
			sourceLibraryId: input.sourceLibraryId ?? null,
			sourceLibraryKind: input.sourceLibraryKind ?? null,
			autoPublishProfileId: input.autoPublishProfileId ?? null,
		})
		.returning();

	// Uploaded files are hosted by us → no auth needed. For URL sources, pass the
	// user's cookies (if any) so login/rate-limited platforms can authenticate.
	const cookies =
		input.sourceType === "url"
			? ((await getUserCookies(user.id)) ?? undefined)
			: undefined;

	try {
		const { job_id } = await dubber.createJob({
			video_input: input.sourceInput,
			source_lang: input.sourceLang,
			target_lang: input.targetLang,
			voice: input.voice,
			source_type: input.sourceType,
			cookies,
			burn_captions: input.burnCaptions,
			deepgram_key: keys.deepgram,
			gemini_key: keys.gemini,
			// Writes the AI captions (NVIDIA NIM); pipeline degrades to a template
			// caption without it.
			nvidia_key: keys.nvidia,
		});

		const [updated] = await db
			.update(dubJobs)
			.set({ dubberJobId: job_id, status: "running", updatedAt: new Date() })
			.where(eq(dubJobs.id, job.id))
			.returning();

		return Response.json({ job: updated }, { status: 201 });
	} catch (err) {
		await db
			.update(dubJobs)
			.set({
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
				updatedAt: new Date(),
			})
			.where(eq(dubJobs.id, job.id));
		throw err;
	}
});
