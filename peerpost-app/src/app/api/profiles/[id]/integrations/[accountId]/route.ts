import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { integrationsCache } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { postpeer } from "@/lib/postpeer";
import { assertAccountInProfile } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string; accountId: string }> };

/**
 * DELETE /api/profiles/:id/integrations/:accountId
 *
 * Disconnect a single connected account (e.g. one LinkedIn/Facebook page).
 * PostPeer's OAuth imports every page an account manages; this lets the user
 * keep only the page(s) they want by removing the rest. Removes it from
 * PostPeer and the local cache.
 */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id, accountId } = await params;

	// Authorize: the account must belong to an ecosystem the user can act on.
	await assertAccountInProfile(user, id, accountId);

	await postpeer.disconnectIntegration(accountId);
	await db
		.delete(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, id),
				eq(integrationsCache.postpeerAccountId, accountId),
			),
		);

	return Response.json({ ok: true });
});
