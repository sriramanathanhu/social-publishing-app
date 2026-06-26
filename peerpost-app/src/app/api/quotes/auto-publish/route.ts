import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { autoPublishQuotes } from "@/lib/quote-autopublish";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
	content: z.string().min(40),
	count: z.number().int().min(1).max(20),
	tone: z.string().max(60).optional(),
	languages: z.array(z.string().max(40)).max(20).optional(),
});

/**
 * POST /api/quotes/auto-publish — one call does the whole "Generate &
 * auto-schedule" flow server-side (one auth check). For each language with a
 * quote rule: generate, render cards, schedule to the mapped accounts (drip).
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const result = await autoPublishQuotes(user, input);
	return Response.json(result);
});
