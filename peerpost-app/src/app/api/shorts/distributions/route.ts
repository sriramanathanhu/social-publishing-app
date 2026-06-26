import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { shortsDistributions } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

/** GET /api/shorts/distributions — the user's saved shorts target lists. */
export const GET = route(async () => {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(shortsDistributions)
		.where(eq(shortsDistributions.userId, user.id))
		.orderBy(desc(shortsDistributions.updatedAt));
	return Response.json({ distributions: rows });
});

const postSchema = z.object({
	id: z.string().uuid().optional(),
	name: z.string().min(1).max(80),
	shortsPerTarget: z.number().int().min(1).max(100).default(10),
	bufferMinutes: z.number().int().min(0).max(10080).default(30),
	gapMinutes: z.number().int().min(0).max(10080).default(60),
	targets: z
		.array(z.object({ profileId: z.string().uuid(), accountId: z.string() }))
		.max(200),
});

/** POST /api/shorts/distributions — create or update a shorts target list. */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = postSchema.parse(await req.json());

	const profileIds = [...new Set(input.targets.map((t) => t.profileId))];
	for (const pid of profileIds) await assertProfileAccess(user, pid);

	if (input.id) {
		const [row] = await db
			.update(shortsDistributions)
			.set({
				name: input.name,
				shortsPerTarget: input.shortsPerTarget,
				bufferMinutes: input.bufferMinutes,
				gapMinutes: input.gapMinutes,
				targets: input.targets,
				updatedAt: new Date(),
			})
			.where(
				and(
					eq(shortsDistributions.id, input.id),
					eq(shortsDistributions.userId, user.id),
				),
			)
			.returning();
		return Response.json({ distribution: row });
	}

	const [row] = await db
		.insert(shortsDistributions)
		.values({
			userId: user.id,
			name: input.name,
			shortsPerTarget: input.shortsPerTarget,
			bufferMinutes: input.bufferMinutes,
			gapMinutes: input.gapMinutes,
			targets: input.targets,
		})
		.returning();
	return Response.json({ distribution: row });
});
