import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { ecosystemMembers, integrationsCache, profiles } from "@/db/schema";
import { type AppUser, HttpError } from "@/lib/auth";

/**
 * Authorization. Anyone may sign in, but acting on an ecosystem requires:
 *   - being a platform admin (users.role = 'admin'), OR
 *   - being APPROVED *and* assigned to that specific ecosystem (profile) via
 *     ecosystem_members.
 * Access is per-ecosystem and many-to-many (a user ↔ many ecosystems).
 */

export function isAdmin(user: AppUser): boolean {
	return user.role === "admin";
}

export function assertAdmin(user: AppUser): void {
	if (!isAdmin(user)) throw new HttpError(403, "Admin only");
}

/** Admins are always approved; otherwise the approved flag governs. */
export function isApproved(user: AppUser): boolean {
	return isAdmin(user) || user.approved;
}

/** Assert the user can access an ecosystem (profile). Returns the profile. */
export async function assertProfileAccess(user: AppUser, profileId: string) {
	const profile = await db.query.profiles.findFirst({
		where: eq(profiles.id, profileId),
	});
	if (!profile) throw new HttpError(404, "Ecosystem not found");

	if (isAdmin(user)) return profile;

	// Unapproved users cannot access any ecosystem.
	if (!user.approved) throw new HttpError(403, "Awaiting approval");

	const m = await db.query.ecosystemMembers.findFirst({
		where: and(
			eq(ecosystemMembers.profileId, profileId),
			eq(ecosystemMembers.userId, user.id),
		),
	});
	// 404 (not 403) so we don't leak existence of ecosystems they aren't on.
	if (!m) throw new HttpError(404, "Ecosystem not found");
	return profile;
}

/**
 * Resolve a PostPeer accountId only if it belongs to an ecosystem the user may
 * act on. Prevents publishing to arbitrary accountIds from the client.
 */
export async function assertAccountInProfile(
	user: AppUser,
	profileId: string,
	postpeerAccountId: string,
) {
	await assertProfileAccess(user, profileId);
	const integration = await db.query.integrationsCache.findFirst({
		where: and(
			eq(integrationsCache.profileId, profileId),
			eq(integrationsCache.postpeerAccountId, postpeerAccountId),
		),
	});
	if (!integration) {
		throw new HttpError(403, "Account is not connected to this ecosystem");
	}
	return integration;
}
