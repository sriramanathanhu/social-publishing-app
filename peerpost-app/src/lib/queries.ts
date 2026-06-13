import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
	analyticsSnapshots,
	ecosystemMembers,
	integrationsCache,
	postsLog,
	profiles,
	teams,
	users,
} from "@/db/schema";
import type { AppUser } from "@/lib/auth";
import { PLATFORMS } from "@/lib/postpeer";
import { isAdmin } from "@/lib/rbac";

/**
 * Server-side read helpers. Access is per-ecosystem: admins see everything;
 * regular users see only ecosystems they're approved-and-assigned to.
 */

/** Ecosystems the user can act on (admin = all; else approved assignments). */
export async function getAccessibleProfiles(user: AppUser) {
	if (isAdmin(user)) {
		const rows = await db
			.select({ profile: profiles, teamName: teams.name })
			.from(profiles)
			.leftJoin(teams, eq(teams.id, profiles.teamId))
			.orderBy(profiles.createdAt);
		return rows.map((r) => ({ ...r.profile, teamName: r.teamName ?? "—" }));
	}
	if (!user.approved) return [];
	const rows = await db
		.select({ profile: profiles, teamName: teams.name })
		.from(ecosystemMembers)
		.innerJoin(profiles, eq(profiles.id, ecosystemMembers.profileId))
		.leftJoin(teams, eq(teams.id, profiles.teamId))
		.where(eq(ecosystemMembers.userId, user.id))
		.orderBy(profiles.createdAt);
	return rows.map((r) => ({ ...r.profile, teamName: r.teamName ?? "—" }));
}

/** Whether the user may connect/publish at all (approved + ≥1 ecosystem). */
export async function hasPlatformAccess(user: AppUser): Promise<boolean> {
	if (isAdmin(user)) return true;
	if (!user.approved) return false;
	const accessible = await getAccessibleProfiles(user);
	return accessible.length > 0;
}

/** Teams that contain at least one ecosystem the user can access. */
export async function getTeamsForUser(user: AppUser) {
	if (isAdmin(user)) {
		return db.select().from(teams).orderBy(teams.createdAt);
	}
	const accessible = await getAccessibleProfiles(user);
	const teamIds = [...new Set(accessible.map((p) => p.teamId).filter(Boolean))] as string[];
	if (teamIds.length === 0) return [];
	return db.select().from(teams).where(inArray(teams.id, teamIds)).orderBy(teams.createdAt);
}

export async function getTeam(teamId: string) {
	return (await db.query.teams.findFirst({ where: eq(teams.id, teamId) })) ?? null;
}

/** Ecosystems in a team the user can access (admin = all in team). */
export async function getAccessibleProfilesInTeam(user: AppUser, teamId: string) {
	const accessible = await getAccessibleProfiles(user);
	return accessible.filter((p) => p.teamId === teamId);
}

export async function getProfile(profileId: string) {
	return (
		(await db.query.profiles.findFirst({ where: eq(profiles.id, profileId) })) ?? null
	);
}

/** Full-platform connection view: every platform + connected flag for a profile. */
export async function getPlatformStatus(profileId: string) {
	const connected = await db
		.select()
		.from(integrationsCache)
		.where(eq(integrationsCache.profileId, profileId));
	const byPlatform = new Map(connected.map((c) => [c.platform, c]));
	return PLATFORMS.map((platform) => {
		const c = byPlatform.get(platform);
		return {
			platform,
			connected: !!c,
			accountId: c?.postpeerAccountId ?? null,
			handle: c?.handle ?? null,
			displayName: c?.displayName ?? null,
		};
	});
}

/** Connected accounts for a profile (for the composer). */
export async function getConnectedAccounts(profileId: string) {
	const rows = await db
		.select()
		.from(integrationsCache)
		.where(eq(integrationsCache.profileId, profileId));
	return rows.map((r) => ({
		platform: r.platform,
		accountId: r.postpeerAccountId,
		handle: r.handle,
	}));
}

type PostStatus = (typeof postsLog.$inferSelect)["status"];

/** Posts across all accessible ecosystems, optionally filtered by status. */
export async function getPostsForUser(
	user: AppUser,
	statuses?: PostStatus[],
	limit = 100,
) {
	const accessible = await getAccessibleProfiles(user);
	if (accessible.length === 0) return [];
	const profileIds = accessible.map((p) => p.id);
	const nameById = new Map(accessible.map((p) => [p.id, p.name]));

	const where = statuses
		? and(inArray(postsLog.profileId, profileIds), inArray(postsLog.status, statuses))
		: inArray(postsLog.profileId, profileIds);

	const rows = await db
		.select()
		.from(postsLog)
		.where(where)
		.orderBy(desc(postsLog.createdAt))
		.limit(limit);

	return rows.map((r) => ({ ...r, profileName: nameById.get(r.profileId) ?? "—" }));
}

// ── Admin queries ───────────────────────────────────────────────────────────

/** Admin: every ecosystem with its team and connected platforms. */
export async function getAllEcosystems() {
	const rows = await db
		.select({ profile: profiles, teamName: teams.name })
		.from(profiles)
		.leftJoin(teams, eq(teams.id, profiles.teamId))
		.orderBy(profiles.createdAt);

	return Promise.all(
		rows.map(async (r) => {
			const integrations = await db
				.select({
					platform: integrationsCache.platform,
					handle: integrationsCache.handle,
				})
				.from(integrationsCache)
				.where(eq(integrationsCache.profileId, r.profile.id));
			return {
				id: r.profile.id,
				name: r.profile.name,
				teamName: r.teamName ?? "—",
				integrations,
			};
		}),
	);
}

/**
 * Cached analytics for the user's accessible ecosystems (optionally one).
 * Returns snapshots with the ecosystem name; sorting/aggregation done in the UI.
 */
export async function getAnalytics(user: AppUser, profileId?: string) {
	const accessible = await getAccessibleProfiles(user);
	let ids = accessible.map((p) => p.id);
	if (profileId) ids = ids.filter((id) => id === profileId);
	if (ids.length === 0) return { rows: [], lastFetched: null as Date | null };

	const nameById = new Map(accessible.map((p) => [p.id, p.name]));
	const rows = await db
		.select()
		.from(analyticsSnapshots)
		.where(inArray(analyticsSnapshots.profileId, ids))
		.orderBy(desc(analyticsSnapshots.publishedAt));

	const lastFetched = rows.reduce<Date | null>(
		(max, r) => (!max || r.fetchedAt > max ? r.fetchedAt : max),
		null,
	);

	return {
		rows: rows.map((r) => ({ ...r, profileName: nameById.get(r.profileId) ?? "—" })),
		lastFetched,
	};
}

/** Admin: simple list of all ecosystems (for assignment pickers). */
export async function getEcosystemOptions() {
	const rows = await db
		.select({ id: profiles.id, name: profiles.name, teamName: teams.name })
		.from(profiles)
		.leftJoin(teams, eq(teams.id, profiles.teamId))
		.orderBy(profiles.createdAt);
	return rows.map((r) => ({ id: r.id, name: r.name, teamName: r.teamName ?? "—" }));
}

/** Admin: every user with role, approval, and assigned ecosystems. */
export async function getAllMembers() {
	const allUsers = await db.select().from(users).orderBy(users.createdAt);

	return Promise.all(
		allUsers.map(async (u) => {
			const assigned = await db
				.select({ id: profiles.id, name: profiles.name })
				.from(ecosystemMembers)
				.innerJoin(profiles, eq(profiles.id, ecosystemMembers.profileId))
				.where(eq(ecosystemMembers.userId, u.id));
			return {
				id: u.id,
				email: u.email,
				name: u.name,
				role: u.role,
				approved: u.approved,
				pending: u.nandiSub.startsWith("pending:"),
				ecosystems: assigned,
			};
		}),
	);
}
