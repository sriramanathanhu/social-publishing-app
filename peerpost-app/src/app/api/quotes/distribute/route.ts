import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { enqueueJob } from "@/lib/background-jobs";
import { route } from "@/lib/http";
import { preflightDistribute } from "@/lib/quote-distribute";

export const runtime = "nodejs";

const schema = z.object({
	content: z.string().min(40),
	count: z.number().int().min(1).max(500),
	tone: z.string().max(60).optional(),
	distributionId: z.string().uuid(),
});

/**
 * POST /api/quotes/distribute — validate cheaply, then ENQUEUE the
 * generate/render/schedule batch (it runs for minutes via the background-jobs
 * cron; the request only returns a "started" ack so it never hits the ~100s
 * edge request cap). Cards + posts appear in the library / Scheduled shortly.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());

	const pre = await preflightDistribute(user, input);
	if (pre.error) return Response.json({ error: pre.error });

	await enqueueJob(
		user.id,
		"quote-distribute",
		input as unknown as Record<string, unknown>,
	);
	return Response.json({ started: true, ecosystems: pre.ecosystems });
});
