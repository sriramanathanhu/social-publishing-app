import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { autoPublishQuotes } from "@/lib/quote-autopublish";

export const runtime = "nodejs";
export const maxDuration = 800;

const schema = z.object({
	content: z.string().min(40),
	count: z.number().int().min(1).max(20),
	tone: z.string().max(60).optional(),
	languages: z.array(z.string().max(40)).max(20).optional(),
});

/**
 * POST /api/quotes/auto-publish — generate + render + schedule per language.
 * Rendering many languages can exceed the ~100s edge request limit, so the work
 * runs in the BACKGROUND (after the response) and we return immediately; the
 * cards + scheduled posts appear in the library / Scheduled as it progresses.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());

	after(async () => {
		try {
			await autoPublishQuotes(user, input);
		} catch (err) {
			console.error("[quotes/auto-publish background]", err);
		}
	});

	return Response.json({ started: true });
});
