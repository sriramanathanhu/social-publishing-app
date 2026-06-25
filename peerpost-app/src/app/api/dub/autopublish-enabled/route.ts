import { and, eq, isNull } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { dubJobs, users } from "@/db/schema";
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

	// Turning it ON only affects dubs finished from now on — never retroactively
	// dump the existing backlog. Mark all already-done dubs as handled so the
	// driver skips them; only future completions auto-publish.
	if (enabled) {
		await db
			.update(dubJobs)
			.set({ autoPublishedAt: new Date() })
			.where(
				and(
					eq(dubJobs.userId, user.id),
					eq(dubJobs.status, "done"),
					isNull(dubJobs.autoPublishedAt),
				),
			);
	}

	await db
		.update(users)
		.set({ dubAutopublish: enabled })
		.where(eq(users.id, user.id));
	return Response.json({ enabled });
});
