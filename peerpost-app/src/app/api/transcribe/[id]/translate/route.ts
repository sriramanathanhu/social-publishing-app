import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { translateText } from "@/lib/translate-text";

export const runtime = "nodejs";
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

const schema = z.object({ lang: z.string().trim().min(2).max(40) });

/**
 * POST /api/transcribe/[id]/translate — translate a finished transcript into the
 * given language (Gemini) and save it as a new transcript, leaving the original
 * intact. The translated copy can then be edited and pushed to the corpus.
 */
export const POST = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const { lang } = schema.parse(await req.json());

	const src = await db.query.transcriptJobs.findFirst({
		where: and(eq(transcriptJobs.id, id), eq(transcriptJobs.userId, user.id)),
	});
	if (!src) throw new HttpError(404, "Not found");
	if (src.status !== "done" || !src.transcript?.trim()) {
		throw new HttpError(400, "Transcript isn't ready yet.");
	}

	const keys = await getUserKeys(user.id);
	if (!keys.gemini) {
		throw new HttpError(400, "Add a Gemini API key in Settings first.");
	}

	const translated = await translateText(src.transcript, lang, keys.gemini);

	const [row] = await db
		.insert(transcriptJobs)
		.values({
			userId: user.id,
			title: `${src.title} · ${lang}`,
			sourceType: "translation",
			sourceInput: `translation:${src.id}`,
			chunks: src.chunks,
			sourceLang: src.outputLang,
			outputLang: lang,
			translate: true,
			status: "done",
			pct: 100,
			transcript: translated,
		})
		.returning();
	return Response.json({ job: row });
});
