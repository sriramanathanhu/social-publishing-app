import type { NextRequest } from "next/server";
import { z } from "zod";
import { getUserKeyPresence, saveUserKeys } from "@/lib/api-keys";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

/** GET /api/keys — which dub keys the current user has set (masked presence). */
export const GET = route(async () => {
	const user = await requireUser();
	const presence = await getUserKeyPresence(user.id);
	return Response.json({ keys: presence });
});

// Empty string clears a key; omitted key is left untouched.
const saveSchema = z.object({
	deepgram: z.string().max(400).optional(),
	gemini: z.string().max(400).optional(),
	mistral: z.string().max(400).optional(),
});

/** PUT /api/keys — save/clear the current user's dub API keys (encrypted). */
export const PUT = route(async (request: NextRequest) => {
	const user = await requireUser();
	const updates = saveSchema.parse(await request.json());
	await saveUserKeys(user.id, updates);
	const presence = await getUserKeyPresence(user.id);
	return Response.json({ keys: presence });
});
