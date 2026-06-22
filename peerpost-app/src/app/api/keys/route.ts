import type { NextRequest } from "next/server";
import { z } from "zod";
import {
	getUserCookiesPresence,
	getUserKeyPresence,
	saveUserCookies,
	saveUserKeys,
} from "@/lib/api-keys";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

async function presenceFor(userId: string) {
	const [keys, cookies] = await Promise.all([
		getUserKeyPresence(userId),
		getUserCookiesPresence(userId),
	]);
	return { keys, cookies };
}

/** GET /api/keys — which dub keys/cookies the current user has set (presence only). */
export const GET = route(async () => {
	const user = await requireUser();
	return Response.json(await presenceFor(user.id));
});

// Empty string clears a value; an omitted field is left untouched.
const saveSchema = z.object({
	deepgram: z.string().max(400).optional(),
	gemini: z.string().max(400).optional(),
	nvidia: z.string().max(400).optional(),
	// A cookies.txt can be large; allow generous room.
	cookies: z.string().max(200_000).optional(),
});

/** PUT /api/keys — save/clear the current user's dub keys and/or cookies (encrypted). */
export const PUT = route(async (request: NextRequest) => {
	const user = await requireUser();
	const { cookies, ...keys } = saveSchema.parse(await request.json());
	await saveUserKeys(user.id, keys);
	if (cookies !== undefined) await saveUserCookies(user.id, cookies);
	return Response.json(await presenceFor(user.id));
});
