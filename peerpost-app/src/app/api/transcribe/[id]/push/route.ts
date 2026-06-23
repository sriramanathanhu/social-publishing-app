import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import {
	corpusConfigured,
	reingestCorpus,
	uploadToCorpus,
} from "@/lib/vertex-ingest";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * POST /api/transcribe/[id]/push — upload the transcript to the GCS corpus and
 * trigger a Vertex incremental import, making it searchable for article
 * generation.
 */
export const POST = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	if (!corpusConfigured()) {
		throw new HttpError(400, "The corpus (GCS + Vertex) isn't configured.");
	}
	const row = await db.query.transcriptJobs.findFirst({
		where: and(eq(transcriptJobs.id, id), eq(transcriptJobs.userId, user.id)),
	});
	if (!row) throw new HttpError(404, "Not found");
	if (row.status !== "done" || !row.transcript?.trim()) {
		throw new HttpError(400, "Transcript isn't ready yet.");
	}

	// A readable title line helps retrieval; then the transcript body.
	const text = `${row.title}\n\n${row.transcript.trim()}\n`;
	const objectName = `transcripts/${row.id}.txt`;
	const gcsUri = await uploadToCorpus(objectName, text);
	await reingestCorpus(gcsUri);

	const [updated] = await db
		.update(transcriptJobs)
		.set({ corpusKey: objectName, pushedAt: new Date(), updatedAt: new Date() })
		.where(eq(transcriptJobs.id, id))
		.returning();
	return Response.json({ job: updated, gcsUri });
});
