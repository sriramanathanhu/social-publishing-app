import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { enqueueJob } from "@/lib/background-jobs";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
	content: z.string().min(40),
	count: z.number().int().min(1).max(500),
	tone: z.string().max(60).optional(),
	languages: z.array(z.string().max(40)).max(20).optional(),
});

/**
 * POST /api/quotes/auto-publish — enqueue the per-language generate + render +
 * schedule batch (runs via the background-jobs cron; returns immediately).
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	await enqueueJob(
		user.id,
		"quote-autopublish",
		input as unknown as Record<string, unknown>,
	);
	return Response.json({ started: true });
});
