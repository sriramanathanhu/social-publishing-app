import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { quoteItems } from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { generateQuotes } from "@/lib/quotes";

export const runtime = "nodejs";

const schema = z.object({
	content: z.string().min(40).max(50_000),
	count: z.number().int().min(1).max(15).default(6),
	tone: z.string().max(40).optional(),
	// Existing quote texts to NOT repeat (regenerate / "more like this").
	avoid: z.array(z.string()).max(40).optional(),
	// Language to write the quotes in (empty/omitted = same as the content).
	outputLang: z.string().max(40).optional(),
});

/**
 * POST /api/quotes — generate social-media quotes from long-form content using
 * the caller's own Gemini (→ NVIDIA fallback) key, and PERSIST them so the
 * user's set survives a refresh. Returns the saved rows (with ids).
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const keys = await getUserKeys(user.id);
	const result = await generateQuotes(input.content, {
		geminiKey: keys.gemini,
		nvidiaKey: keys.nvidia,
		count: input.count,
		tone: input.tone,
		avoid: input.avoid,
		outputLang: input.outputLang,
	});
	const saved = result.quotes.length
		? await db
				.insert(quoteItems)
				.values(
					result.quotes.map((q) => ({
						userId: user.id,
						text: q.text,
						hashtags: q.hashtags,
					})),
				)
				.returning()
		: [];
	return Response.json({ provider: result.provider, quotes: saved });
});
