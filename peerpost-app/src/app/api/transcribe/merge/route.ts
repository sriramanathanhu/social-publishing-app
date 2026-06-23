import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
	ids: z.array(z.string().uuid()).min(2).max(500),
	title: z.string().max(200).optional(),
});

/**
 * POST /api/transcribe/merge — concatenate the selected completed transcripts
 * (in chunk / chronological order) into a single new transcript that can then
 * be edited and pushed to the corpus.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const { ids, title } = schema.parse(await req.json());

	const rows = await db
		.select()
		.from(transcriptJobs)
		.where(
			and(eq(transcriptJobs.userId, user.id), inArray(transcriptJobs.id, ids)),
		);
	const done = rows.filter((r) => r.status === "done" && r.transcript?.trim());
	if (done.length < 2) {
		throw new HttpError(400, "Select at least two completed transcripts.");
	}
	// Chunk order = order they were created (live chunks arrive sequentially).
	done.sort(
		(a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
	);

	const merged = done
		.map((r) => (r.transcript ?? "").trim())
		.filter(Boolean)
		.join("\n\n");

	const [row] = await db
		.insert(transcriptJobs)
		.values({
			userId: user.id,
			title: title?.trim() || `Merged transcript (${done.length} chunks)`,
			sourceType: "merged",
			sourceInput: `merged:${done.length}`,
			chunks: done.length,
			sourceLang: done[0].sourceLang,
			outputLang: done[0].outputLang,
			translate: false,
			status: "done",
			pct: 100,
			transcript: merged,
		})
		.returning();
	return Response.json({ job: row });
});
