import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { dubber } from "@/lib/dubber";
import { route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** GET — current status; polls the sidecar and syncs the row while running. */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const row = await db.query.transcriptJobs.findFirst({
		where: and(eq(transcriptJobs.id, id), eq(transcriptJobs.userId, user.id)),
	});
	if (!row) throw new HttpError(404, "Not found");

	if (
		(row.status === "queued" || row.status === "running") &&
		row.dubberJobId
	) {
		try {
			const s = await dubber.getTranscribeStatus(row.dubberJobId);
			const status =
				s.status === "done"
					? "done"
					: s.status === "failed"
						? "failed"
						: "running";
			const [updated] = await db
				.update(transcriptJobs)
				.set({
					status,
					pct: s.pct,
					stage: s.stage,
					message: s.message,
					transcript: s.transcript ?? row.transcript,
					error: s.error ?? null,
					updatedAt: new Date(),
				})
				.where(eq(transcriptJobs.id, id))
				.returning();
			return Response.json({ job: updated });
		} catch (e) {
			// Sidecar unreachable / job expired — report current row, don't crash.
			return Response.json({
				job: row,
				warning: e instanceof Error ? e.message : "status check failed",
			});
		}
	}
	return Response.json({ job: row });
});

const patchSchema = z.object({
	title: z.string().max(200).optional(),
	transcript: z.string().max(500_000).optional(),
});

/** PATCH — edit the title or transcript text. */
export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const patch = patchSchema.parse(await req.json());
	const [row] = await db
		.update(transcriptJobs)
		.set({ ...patch, updatedAt: new Date() })
		.where(and(eq(transcriptJobs.id, id), eq(transcriptJobs.userId, user.id)))
		.returning();
	if (!row) throw new HttpError(404, "Not found");
	return Response.json({ job: row });
});

/** DELETE — remove a transcription job. */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await db
		.delete(transcriptJobs)
		.where(and(eq(transcriptJobs.id, id), eq(transcriptJobs.userId, user.id)));
	return Response.json({ ok: true });
});
