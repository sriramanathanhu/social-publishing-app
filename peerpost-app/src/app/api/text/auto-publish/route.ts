import { after, type NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { autoScheduleText } from "@/lib/text-autopublish";

export const runtime = "nodejs";
export const maxDuration = 800;

const schema = z.object({
	kind: z.enum(["article", "transcript"]),
	itemId: z.string().uuid(),
	languages: z.array(z.string().max(40)).min(1).max(20),
});

/**
 * POST /api/text/auto-publish — translate one article/transcript into the chosen
 * languages and schedule each to that language's accounts. Translating long text
 * into several languages can exceed the ~100s edge request limit, so the work
 * runs in the BACKGROUND (after the response) and we return immediately; the
 * scheduled posts appear in Scheduled as it progresses.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());

	after(async () => {
		try {
			await autoScheduleText(user, input);
		} catch (err) {
			console.error("[text/auto-publish background]", err);
		}
	});

	return Response.json({ started: true });
});
