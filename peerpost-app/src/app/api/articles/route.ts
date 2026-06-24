import { desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import { generateArticle } from "@/lib/articles";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
	topic: z.string().trim().min(3).max(5000),
	tone: z.string().max(120).optional(),
	length: z.enum(["short", "medium", "long"]).optional(),
	quality: z.enum(["standard", "high"]).optional(),
	instructions: z.string().max(10000).optional(),
	outputLang: z.string().max(40).optional(),
});

/** GET /api/articles — the caller's saved articles (recent first). */
export const GET = route(async () => {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(articles)
		.where(eq(articles.userId, user.id))
		.orderBy(desc(articles.createdAt))
		.limit(100);
	return Response.json({ articles: rows });
});

/**
 * POST /api/articles — generate a grounded long-form article from the corpus
 * (Vertex AI Search retrieval → Gemini/NVIDIA writing) and save it.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const keys = await getUserKeys(user.id);
	const result = await generateArticle(input.topic, {
		geminiKey: keys.gemini,
		nvidiaKey: keys.nvidia,
		tone: input.tone,
		length: input.length,
		quality: input.quality,
		instructions: input.instructions,
		outputLang: input.outputLang,
	});
	const [row] = await db
		.insert(articles)
		.values({
			userId: user.id,
			topic: input.topic,
			title: result.title,
			content: result.content,
			citations: result.citations,
			provider: result.provider,
			outputLang: input.outputLang || null,
		})
		.returning();
	return Response.json({ article: row });
});
