import type { NextRequest } from "next/server";
import { z } from "zod";
import { getUserKeys } from "@/lib/api-keys";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { generateQuotes } from "@/lib/quotes";

export const runtime = "nodejs";

const schema = z.object({
	content: z.string().min(40).max(50_000),
	count: z.number().int().min(1).max(15).default(6),
	tone: z.string().max(40).optional(),
});

/**
 * POST /api/quotes — generate social-media quotes from long-form content using
 * the caller's own Gemini (→ NVIDIA fallback) key. Text-only; no persistence —
 * the user publishes the ones they like, which are then logged like any post.
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
	});
	return Response.json(result);
});
