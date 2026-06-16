import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { integrationsCache } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { PLATFORMS } from "@/lib/postpeer";
import { assertProfileAccess } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

const putSchema = z.object({
	platform: z.enum(PLATFORMS),
	activeAccountIds: z.array(z.string()),
});

/**
 * PUT /api/profiles/:id/integrations/active
 *
 * "Keep only these active" for a platform: within the given platform, mark the
 * listed accounts active and ALL others inactive — in one operation, so picking
 * a handful out of hundreds of imported pages is a single save. Non-destructive
 * (accounts stay connected in PostPeer; inactive ones are just hidden from the
 * composer/MCP), so it survives reconnects.
 */
export const PUT = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const { platform, activeAccountIds } = putSchema.parse(await request.json());

	// Everything on this platform → inactive, then flip the chosen ones back on.
	await db
		.update(integrationsCache)
		.set({ active: false })
		.where(
			and(
				eq(integrationsCache.profileId, id),
				eq(integrationsCache.platform, platform),
			),
		);

	if (activeAccountIds.length > 0) {
		await db
			.update(integrationsCache)
			.set({ active: true })
			.where(
				and(
					eq(integrationsCache.profileId, id),
					eq(integrationsCache.platform, platform),
					inArray(integrationsCache.postpeerAccountId, activeAccountIds),
				),
			);
	}

	return Response.json({ ok: true, active: activeAccountIds.length });
});
