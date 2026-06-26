import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { quoteDistributions } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

/** GET /api/quotes/distributions — the user's saved distribution lists. */
export const GET = route(async () => {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(quoteDistributions)
		.where(eq(quoteDistributions.userId, user.id))
		.orderBy(desc(quoteDistributions.updatedAt));
	return Response.json({ distributions: rows });
});

const postSchema = z.object({
	id: z.string().uuid().optional(), // present = update
	name: z.string().min(1).max(80),
	lang: z.string().min(1).max(40).default("English"),
	cardsPerTarget: z.number().int().min(1).max(100).default(10),
	bufferMinutes: z.number().int().min(0).max(10080).default(30),
	gapMinutes: z.number().int().min(0).max(10080).default(60),
	targets: z
		.array(z.object({ profileId: z.string().uuid(), accountId: z.string() }))
		.max(200),
});

/** POST /api/quotes/distributions — create or update a distribution list. */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = postSchema.parse(await req.json());

	// The user must have access to every ecosystem they're targeting.
	const profileIds = [...new Set(input.targets.map((t) => t.profileId))];
	for (const pid of profileIds) await assertProfileAccess(user, pid);

	if (input.id) {
		const [row] = await db
			.update(quoteDistributions)
			.set({
				name: input.name,
				lang: input.lang,
				cardsPerTarget: input.cardsPerTarget,
				bufferMinutes: input.bufferMinutes,
				gapMinutes: input.gapMinutes,
				targets: input.targets,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(quoteDistributions.id, input.id),
					eq(quoteDistributions.userId, user.id),
				),
			)
			.returning();
		return Response.json({ distribution: row });
	}

	const [row] = await db
		.insert(quoteDistributions)
		.values({
			userId: user.id,
			name: input.name,
			lang: input.lang,
			cardsPerTarget: input.cardsPerTarget,
			bufferMinutes: input.bufferMinutes,
			gapMinutes: input.gapMinutes,
			targets: input.targets,
		})
		.returning();
	return Response.json({ distribution: row });
});
