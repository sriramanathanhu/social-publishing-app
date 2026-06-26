import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { distributeQuotes } from "@/lib/quote-distribute";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
	content: z.string().min(40),
	count: z.number().int().min(1).max(500),
	tone: z.string().max(60).optional(),
	distributionId: z.string().uuid(),
});

/**
 * POST /api/quotes/distribute — generate `count` cards and SPREAD them across
 * the saved distribution list's targets (a distinct slice per target). One
 * auth check; runs entirely server-side.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const result = await distributeQuotes(user, input);
	return Response.json(result);
});
