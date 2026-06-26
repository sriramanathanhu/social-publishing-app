import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { enqueueJob } from "@/lib/background-jobs";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
	kind: z.enum(["article", "transcript"]),
	itemId: z.string().uuid(),
	languages: z.array(z.string().max(40)).min(1).max(20),
});

/**
 * POST /api/text/auto-publish — enqueue the translate + schedule batch (runs via
 * the background-jobs cron; returns immediately).
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	await enqueueJob(
		user.id,
		"text-autopublish",
		input as unknown as Record<string, unknown>,
	);
	return Response.json({ started: true });
});
