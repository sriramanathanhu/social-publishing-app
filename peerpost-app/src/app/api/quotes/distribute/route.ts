import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { distributeQuotes, preflightDistribute } from "@/lib/quote-distribute";

export const runtime = "nodejs";
export const maxDuration = 800;

const schema = z.object({
	content: z.string().min(40),
	count: z.number().int().min(1).max(500),
	tone: z.string().max(60).optional(),
	distributionId: z.string().uuid(),
});

/**
 * POST /api/quotes/distribute — generate `count` cards and SPREAD them across
 * the saved distribution list's ecosystems (a distinct slice per ecosystem).
 *
 * Rendering a large batch through the card sidecar takes minutes — far longer
 * than the ~100s edge/proxy (Cloudflare) request limit — so we validate cheaply
 * up front, then run the generate/render/schedule work in the BACKGROUND
 * (after the response is sent) and return immediately. The cards + scheduled
 * posts show up in the library / Scheduled as the job progresses.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());

	const pre = await preflightDistribute(user, input);
	if (pre.error) return Response.json({ error: pre.error });

	after(async () => {
		try {
			await distributeQuotes(user, input);
		} catch (err) {
			console.error("[quotes/distribute background]", err);
		}
	});

	return Response.json({ started: true, ecosystems: pre.ecosystems });
});
