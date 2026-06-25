import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { dubAutopublishRules } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { DUB_LANGUAGE_CODES } from "@/lib/dub-options";
import { route } from "@/lib/http";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

/** GET /api/dub/autopublish-rules?profileId= — rules for one ecosystem. */
export const GET = route(async (req: NextRequest) => {
	const user = await requireUser();
	const profileId = new URL(req.url).searchParams.get("profileId") ?? "";
	if (!profileId) throw new HttpError(400, "profileId required");
	await assertProfileAccess(user, profileId);
	const rules = await db
		.select()
		.from(dubAutopublishRules)
		.where(eq(dubAutopublishRules.profileId, profileId));
	return Response.json({ rules });
});

const putSchema = z.object({
	profileId: z.string().uuid(),
	lang: z.enum(DUB_LANGUAGE_CODES as [string, ...string[]]),
	accountIds: z.array(z.string()).max(50),
	bufferMinutes: z.number().int().min(0).max(10080).default(30),
});

/** PUT /api/dub/autopublish-rules — upsert the rule for one (ecosystem, language).
 * Empty accountIds removes the rule. */
export const PUT = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = putSchema.parse(await req.json());
	await assertProfileAccess(user, input.profileId);

	if (input.accountIds.length === 0) {
		await db
			.delete(dubAutopublishRules)
			.where(
				and(
					eq(dubAutopublishRules.profileId, input.profileId),
					eq(dubAutopublishRules.lang, input.lang),
				),
			);
		return Response.json({ ok: true, removed: true });
	}

	const [row] = await db
		.insert(dubAutopublishRules)
		.values({
			profileId: input.profileId,
			lang: input.lang,
			accountIds: input.accountIds,
			bufferMinutes: input.bufferMinutes,
		})
		.onConflictDoUpdate({
			target: [dubAutopublishRules.profileId, dubAutopublishRules.lang],
			set: {
				accountIds: input.accountIds,
				bufferMinutes: input.bufferMinutes,
				updatedAt: new Date(),
			},
		})
		.returning();
	return Response.json({ rule: row });
});
