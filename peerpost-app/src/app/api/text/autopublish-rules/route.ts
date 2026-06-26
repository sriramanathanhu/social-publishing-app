import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { textAutopublishRules } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getAccessibleProfiles } from "@/lib/queries";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

const KIND = z.enum(["article", "transcript"]);

/**
 * GET /api/text/autopublish-rules?kind=&profileId= — rules for one ecosystem.
 * GET /api/text/autopublish-rules?kind=&languages=1 — distinct languages the
 * user has any rule for (across accessible ecosystems), for the language picker.
 */
export const GET = route(async (req: NextRequest) => {
	const user = await requireUser();
	const sp = new URL(req.url).searchParams;
	const kind = KIND.parse(sp.get("kind"));

	if (sp.get("languages")) {
		const profileIds = (await getAccessibleProfiles(user)).map((p) => p.id);
		if (profileIds.length === 0) return Response.json({ languages: [] });
		const rows = await db
			.select()
			.from(textAutopublishRules)
			.where(
				and(
					eq(textAutopublishRules.kind, kind),
					inArray(textAutopublishRules.profileId, profileIds),
				),
			);
		const langs = [
			...new Set(rows.filter((r) => r.accountIds.length).map((r) => r.lang)),
		];
		return Response.json({ languages: langs });
	}

	const profileId = sp.get("profileId") ?? "";
	if (!profileId) throw new HttpError(400, "profileId required");
	await assertProfileAccess(user, profileId);
	const rules = await db
		.select()
		.from(textAutopublishRules)
		.where(
			and(
				eq(textAutopublishRules.profileId, profileId),
				eq(textAutopublishRules.kind, kind),
			),
		);
	return Response.json({ rules });
});

const putSchema = z.object({
	profileId: z.string().uuid(),
	kind: KIND,
	lang: z.string().min(1).max(40),
	accountIds: z.array(z.string()).max(50),
	bufferMinutes: z.number().int().min(0).max(10080).default(30),
	gapMinutes: z.number().int().min(0).max(10080).default(0),
});

/** PUT — upsert the rule for one (ecosystem, kind, language). Empty accountIds
 * removes it. */
export const PUT = route(async (req: NextRequest) => {
	const user = await requireUser();
	const input = putSchema.parse(await req.json());
	await assertProfileAccess(user, input.profileId);

	if (input.accountIds.length === 0) {
		await db
			.delete(textAutopublishRules)
			.where(
				and(
					eq(textAutopublishRules.profileId, input.profileId),
					eq(textAutopublishRules.kind, input.kind),
					eq(textAutopublishRules.lang, input.lang),
				),
			);
		return Response.json({ ok: true, removed: true });
	}

	const [row] = await db
		.insert(textAutopublishRules)
		.values({
			profileId: input.profileId,
			kind: input.kind,
			lang: input.lang,
			accountIds: input.accountIds,
			bufferMinutes: input.bufferMinutes,
			gapMinutes: input.gapMinutes,
		})
		.onConflictDoUpdate({
			target: [
				textAutopublishRules.profileId,
				textAutopublishRules.kind,
				textAutopublishRules.lang,
			],
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
