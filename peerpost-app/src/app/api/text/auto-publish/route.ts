import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { autoScheduleText } from "@/lib/text-autopublish";

export const runtime = "nodejs";
export const maxDuration = 300;

const schema = z.object({
	kind: z.enum(["article", "transcript"]),
	itemId: z.string().uuid(),
	languages: z.array(z.string().max(40)).min(1).max(20),
});

/**
 * POST /api/text/auto-publish — translate one generated article/transcript into
 * the chosen languages and schedule each translation to that language's mapped
 * accounts (text post). One auth check; runs server-side.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const result = await autoScheduleText(user, input);
	return Response.json(result);
});
