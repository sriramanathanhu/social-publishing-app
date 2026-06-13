import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { integrationsCache, profiles } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { PLATFORMS } from "@/lib/postpeer";
import { assertProfileAccess } from "@/lib/rbac";
import { syncProfileIntegrations } from "@/lib/sync";

type Ctx = { params: Promise<{ id: string }> };

/** POST — manually re-sync this profile's connections from PostPeer. */
export const POST = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const profile = await db.query.profiles.findFirst({ where: eq(profiles.id, id) });
	if (!profile) return Response.json({ error: "Profile not found" }, { status: 404 });

	const count = await syncProfileIntegrations(profile, user.id);
	return Response.json({ ok: true, synced: count });
});

/**
 * GET /api/profiles/:id/integrations
 *
 * Returns the "full set of platforms" view (req #2): every platform PostPeer
 * supports, each marked connected/not-connected for this profile.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const connected = await db
		.select()
		.from(integrationsCache)
		.where(eq(integrationsCache.profileId, id));

	const byPlatform = new Map(connected.map((c) => [c.platform, c]));

	const platforms = PLATFORMS.map((platform) => {
		const c = byPlatform.get(platform);
		return {
			platform,
			connected: !!c,
			accountId: c?.postpeerAccountId ?? null,
			handle: c?.handle ?? null,
			displayName: c?.displayName ?? null,
			status: c?.status ?? "disconnected",
		};
	});

	return Response.json({ platforms });
});
