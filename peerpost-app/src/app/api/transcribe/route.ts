import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import { HttpError, requireUser } from "@/lib/auth";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const LANGS = ["Tamil", "English"] as const;

const schema = z.object({
	title: z.string().max(200).optional(),
	sourceType: z.enum(["upload", "drive"]),
	sourceInput: z.string().min(4).max(2000),
	chunks: z.number().int().min(1).max(50),
	sourceLang: z.enum(LANGS),
	outputLang: z.enum(LANGS),
	translate: z.boolean(),
});

/** GET /api/transcribe — the caller's transcription jobs (recent first). */
export const GET = route(async () => {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(transcriptJobs)
		.where(eq(transcriptJobs.userId, user.id))
		.orderBy(desc(transcriptJobs.createdAt))
		.limit(100);
	return Response.json({ jobs: rows });
});

/** POST /api/transcribe — start a transcription job on the sidecar. */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const keys = await getUserKeys(user.id);
	if (!keys.gemini) {
		throw new HttpError(
			400,
			"Add a Gemini API key in Settings → Service keys first.",
		);
	}

	const title =
		input.title?.trim() ||
		(input.sourceType === "drive" ? "Drive audio" : "Uploaded audio");

	const [row] = await db
		.insert(transcriptJobs)
		.values({
			userId: user.id,
			title,
			sourceType: input.sourceType,
			sourceInput: input.sourceInput,
			chunks: input.chunks,
			sourceLang: input.sourceLang,
			outputLang: input.outputLang,
			translate: input.translate,
			status: "queued",
		})
		.returning();

	try {
		const { job_id } = await dubber.createTranscribe({
			source_type: input.sourceType,
			source_input: input.sourceInput,
			chunks: input.chunks,
			source_lang: input.sourceLang,
			output_lang: input.outputLang,
			translate: input.translate,
			gemini_key: keys.gemini,
		});
		const [updated] = await db
			.update(transcriptJobs)
			.set({ dubberJobId: job_id, status: "running", updatedAt: new Date() })
			.where(eq(transcriptJobs.id, row.id))
			.returning();
		return Response.json({ job: updated });
	} catch (e) {
		await db
			.update(transcriptJobs)
			.set({
				status: "failed",
				error: e instanceof Error ? e.message : "Could not start the job",
				updatedAt: new Date(),
			})
			.where(eq(transcriptJobs.id, row.id));
		throw e;
	}
});
