import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { integrationsCache, type profiles } from "@/db/schema";
import { asIntegrationArray, postpeer } from "@/lib/postpeer";

type ProfileRow = typeof profiles.$inferSelect;

/**
 * Pull the profile's integrations from PostPeer into integrations_cache.
 * Used both by the OAuth callback and the manual "Refresh connections" action,
 * so the dashboard stays correct even if the post-OAuth redirect is missed.
 *
 * Note: the value stored as postpeerAccountId is the integration `id` — that's
 * what POST /posts expects as `accountId` (verified against the live API).
 */
export async function syncProfileIntegrations(
	profile: ProfileRow,
	userId: string,
): Promise<number> {
	const all = asIntegrationArray(await postpeer.listIntegrations());
	const mine = all.filter((i) => i.profileId === profile.postpeerProfileId);

	for (const i of mine) {
		await db
			.insert(integrationsCache)
			.values({
				profileId: profile.id,
				platform: i.platform,
				postpeerAccountId: i.id,
				handle: i.username ?? null,
				displayName: i.displayName ?? null,
				status: "connected",
				connectedByUserId: userId,
				syncedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: integrationsCache.postpeerAccountId,
				set: {
					handle: i.username ?? null,
					displayName: i.displayName ?? null,
					status: "connected",
					syncedAt: new Date(),
				},
			});
	}

	// Drop locally-cached integrations that PostPeer no longer reports for this
	// profile (e.g. disconnected elsewhere).
	const liveIds = new Set(mine.map((i) => i.id));
	const cached = await db
		.select()
		.from(integrationsCache)
		.where(eq(integrationsCache.profileId, profile.id));
	for (const c of cached) {
		if (!liveIds.has(c.postpeerAccountId)) {
			await db
				.delete(integrationsCache)
				.where(
					and(
						eq(integrationsCache.profileId, profile.id),
						eq(integrationsCache.postpeerAccountId, c.postpeerAccountId),
					),
				);
		}
	}

	return mine.length;
}
