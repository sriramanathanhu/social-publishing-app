import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { quoteAutopublishRules } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

/** GET /api/quotes/autopublish-rules?profileId= — quote rules for one ecosystem. */
export const GET = route(async (req: NextRequest) => {
	const user = await requireUser();
	const profileId = new URL(req.url).searchParams.get("profileId") ?? "";
	if (!profileId) throw new HttpError(400, "profileId required");
	await assertProfileAccess(user, profileId);
	const rules = await db
		.select()
		.from(quoteAutopublishRules)
		.where(eq(quoteAutopublishRules.profileId, profileId));
	return Response.json({ rules });
});

const putSchema = z.object({
	profileId: z.string().uuid(),
	lang: z.string().min(1).max(40), // quote output-language label, e.g. "Hindi"
	accountIds: z.array(z.string()).max(50),
	bufferMinutes: z.number().int().min(0).max(10080).default(30),
	gapMinutes: z.number().int().min(0).max(10080).default(0),
});

/** PUT /api/quotes/autopublish-rules — upsert the rule for one (ecosystem,
 * language). Empty accountIds removes the rule. */
export const PUT = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = putSchema.parse(await req.json());
	await assertProfileAccess(user, input.profileId);

	if (input.accountIds.length === 0) {
		await db
			.delete(quoteAutopublishRules)
			.where(
				and(
					eq(quoteAutopublishRules.profileId, input.profileId),
					eq(quoteAutopublishRules.lang, input.lang),
				),
			);
		return Response.json({ ok: true, removed: true });
	}

	const [row] = await db
		.insert(quoteAutopublishRules)
		.values({
			profileId: input.profileId,
			lang: input.lang,
			accountIds: input.accountIds,
			bufferMinutes: input.bufferMinutes,
			gapMinutes: input.gapMinutes,
		})
		.onConflictDoUpdate({
			target: [quoteAutopublishRules.profileId, quoteAutopublishRules.lang],
			set: {
				accountIds: input.accountIds,
				bufferMinutes: input.bufferMinutes,
				gapMinutes: input.gapMinutes,
				updatedAt: new Date(),
			},
		})
		.returning();
	return Response.json({ rule: row });
});
