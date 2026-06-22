import type { NextRequest } from "next/server";
import { z } from "zod";
import { getUserKeys } from "@/lib/api-keys";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { tailorQuote } from "@/lib/quotes";

export const runtime = "nodejs";

const schema = z.object({
	quote: z.string().min(1).max(2000),
	platforms: z.array(z.string()).min(1).max(15),
	tone: z.string().max(40).optional(),
});

/**
 * POST /api/quotes/tailor — rewrite one quote per target platform (length/tone/
 * hashtags), using the caller's Gemini → NVIDIA keys. Returns platform → text.
 */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = schema.parse(await req.json());
	const keys = await getUserKeys(user.id);
	const result = await tailorQuote(input.quote, input.platforms, {
		geminiKey: keys.gemini,
		nvidiaKey: keys.nvidia,
		tone: input.tone,
	});
	return Response.json(result);
});
