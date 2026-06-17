import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
	integrationsCache,
	platformEnum,
	type profiles,
	providerProfiles,
} from "@/db/schema";
import { asIntegrationArray, postpeer } from "@/lib/postpeer";
import { listZernioAccounts } from "@/lib/providers/zernio";

type ProfileRow = typeof profiles.$inferSelect;

const KNOWN_PLATFORMS = new Set<string>(platformEnum.enumValues);

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
	// profile (e.g. disconnected elsewhere). Scope to provider='postpeer' so we
	// never touch this ecosystem's Zernio accounts.
	const liveIds = new Set(mine.map((i) => i.id));
	const cached = await db
		.select()
		.from(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, profile.id),
				eq(integrationsCache.provider, "postpeer"),
			),
		);
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

/**
 * Link a Zernio profile to one of our ecosystems and import its connected
 * accounts into integrations_cache (provider='zernio'). Stores the mapping in
 * provider_profiles so the publish path can pass Zernio the right profileId.
 *
 * Idempotent: re-running refreshes account metadata and prunes Zernio accounts
 * that no longer exist under that profile. Only touches provider='zernio' rows,
 * so an ecosystem's PostPeer accounts are untouched. Returns the count imported.
 */
export async function importZernioProfile(
	profile: ProfileRow,
	externalProfileId: string,
	userId: string,
): Promise<number> {
	const accounts = await listZernioAccounts(externalProfileId);
	const supported = accounts.filter((a) => KNOWN_PLATFORMS.has(a.platform));

	// Persist the ecosystem → Zernio profile mapping.
	await db
		.insert(providerProfiles)
		.values({
			profileId: profile.id,
			provider: "zernio",
			externalProfileId,
		})
		.onConflictDoUpdate({
			target: [providerProfiles.profileId, providerProfiles.provider],
			set: { externalProfileId },
		});

	for (const a of supported) {
		await db
			.insert(integrationsCache)
			.values({
				profileId: profile.id,
				provider: "zernio",
				platform: a.platform as (typeof platformEnum.enumValues)[number],
				postpeerAccountId: a.externalId,
				handle: a.handle,
				displayName: a.displayName,
				status: "connected",
				connectedByUserId: userId,
				syncedAt: new Date(),
			})
			.onConflictDoUpdate({
				target: integrationsCache.postpeerAccountId,
				set: {
					handle: a.handle,
					displayName: a.displayName,
					status: "connected",
					syncedAt: new Date(),
				},
			});
	}

	// Prune Zernio accounts under THIS ecosystem that Zernio no longer reports.
	const liveIds = new Set(supported.map((a) => a.externalId));
	const cached = await db
		.select()
		.from(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, profile.id),
				eq(integrationsCache.provider, "zernio"),
			),
		);
	for (const c of cached) {
		if (!liveIds.has(c.postpeerAccountId)) {
			await db
				.delete(integrationsCache)
				.where(eq(integrationsCache.postpeerAccountId, c.postpeerAccountId));
		}
	}

	return supported.length;
}
