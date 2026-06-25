import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({ enabled: z.boolean() });

/**
 * PUT /api/dub/autopublish-enabled — the global on/off for THIS user's dub
 * auto-publishing. When on, every finished dub of theirs routes by the saved
 * language→account rules. When off, auto-publishing pauses (rules are kept).
 */
export const PUT = route(async (req: NextRequest) => {
	const user = await requireUser();
	const { enabled } = schema.parse(await req.json());
	await db
		.update(users)
		.set({ dubAutopublish: enabled })
		.where(eq(users.id, user.id));
	return Response.json({ enabled });
});
