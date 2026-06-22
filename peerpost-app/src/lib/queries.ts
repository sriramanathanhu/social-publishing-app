import { and, count, desc, eq, inArray } from "drizzle-orm";
import { cache } from "react";
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

/**
 * Ecosystems the user can act on (admin = all; else approved assignments).
 * Wrapped in React `cache()` so the several callers within one request (pages,
 * getAnalytics, getPostsForUser, getTeamsForUser) share a single DB round-trip.
 */
export const getAccessibleProfiles = cache(async (user: AppUser) => {
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
});

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
	const teamIds = [
		...new Set(accessible.map((p) => p.teamId).filter(Boolean)),
	] as string[];
	if (teamIds.length === 0) return [];
	return db
		.select()
		.from(teams)
		.where(inArray(teams.id, teamIds))
		.orderBy(teams.createdAt);
}

export async function getTeam(teamId: string) {
	return (
		(await db.query.teams.findFirst({ where: eq(teams.id, teamId) })) ?? null
	);
}

/** Ecosystems in a team the user can access (admin = all in team). */
export async function getAccessibleProfilesInTeam(
	user: AppUser,
	teamId: string,
) {
	const accessible = await getAccessibleProfiles(user);
	return accessible.filter((p) => p.teamId === teamId);
}

export async function getProfile(profileId: string) {
	return (
		(await db.query.profiles.findFirst({
			where: eq(profiles.id, profileId),
		})) ?? null
	);
}

/**
 * Full-platform connection view: every platform, with ALL connected accounts.
 * A platform can have multiple accounts (e.g. several LinkedIn pages), so each
 * is listed individually rather than collapsed to one.
 */
export async function getPlatformStatus(profileId: string) {
	const connected = await db
		.select()
		.from(integrationsCache)
		.where(eq(integrationsCache.profileId, profileId));
	const byPlatform = new Map<string, typeof connected>();
	for (const c of connected) {
		const arr = byPlatform.get(c.platform) ?? [];
		arr.push(c);
		byPlatform.set(c.platform, arr);
	}
	return PLATFORMS.map((platform) => {
		const accts = byPlatform.get(platform) ?? [];
		return {
			platform,
			connected: accts.length > 0,
			activeCount: accts.filter((c) => c.active).length,
			accounts: accts.map((c) => ({
				accountId: c.postpeerAccountId,
				handle: c.handle,
				displayName: c.displayName,
				active: c.active,
			})),
		};
	});
}

/** Map of profileId → connected-account count, in one grouped query. */
export async function getIntegrationCounts(
	profileIds: string[],
): Promise<Map<string, number>> {
	if (profileIds.length === 0) return new Map();
	const rows = await db
		.select({ profileId: integrationsCache.profileId, count: count() })
		.from(integrationsCache)
		.where(inArray(integrationsCache.profileId, profileIds))
		.groupBy(integrationsCache.profileId);
	return new Map(rows.map((r) => [r.profileId, Number(r.count)]));
}

/** Connected, ACTIVE accounts for a profile (for the composer). */
export async function getConnectedAccounts(profileId: string) {
	const rows = await db
		.select()
		.from(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, profileId),
				eq(integrationsCache.active, true),
			),
		);
	return rows.map((r) => ({
		platform: r.platform,
		accountId: r.postpeerAccountId,
		handle: r.handle,
		provider: r.provider,
	}));
}

/** All accounts for a profile+platform, with active state (for management UI). */
export async function getPlatformAccounts(profileId: string, platform: string) {
	const rows = await db
		.select()
		.from(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, profileId),
				eq(integrationsCache.platform, platform as (typeof PLATFORMS)[number]),
			),
		)
		.orderBy(integrationsCache.handle);
	return rows.map((r) => ({
		accountId: r.postpeerAccountId,
		handle: r.handle,
		displayName: r.displayName,
		active: r.active,
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
		? and(
				inArray(postsLog.profileId, profileIds),
				inArray(postsLog.status, statuses),
			)
		: inArray(postsLog.profileId, profileIds);

	const rows = await db
		.select()
		.from(postsLog)
		.where(where)
		.orderBy(desc(postsLog.createdAt))
		.limit(limit);

	return rows.map((r) => ({
		...r,
		profileName: nameById.get(r.profileId) ?? "—",
	}));
}

// ── Admin queries ───────────────────────────────────────────────────────────

/** Admin: every ecosystem with its team and connected platforms. */
export async function getAllEcosystems() {
	const rows = await db
		.select({ profile: profiles, teamName: teams.name })
		.from(profiles)
		.leftJoin(teams, eq(teams.id, profiles.teamId))
		.orderBy(profiles.createdAt);

	// One query for all integrations, grouped in memory (avoids N+1).
	const allIntegrations = await db
		.select({
			profileId: integrationsCache.profileId,
			platform: integrationsCache.platform,
			handle: integrationsCache.handle,
		})
		.from(integrationsCache);
	const byProfile = new Map<
		string,
		{ platform: string; handle: string | null }[]
	>();
	for (const i of allIntegrations) {
		const arr = byProfile.get(i.profileId) ?? [];
		arr.push({ platform: i.platform, handle: i.handle });
		byProfile.set(i.profileId, arr);
	}

	return rows.map((r) => ({
		id: r.profile.id,
		name: r.profile.name,
		teamId: r.profile.teamId,
		teamName: r.teamName ?? "—",
		integrations: byProfile.get(r.profile.id) ?? [],
	}));
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
		rows: rows.map((r) => ({
			...r,
			profileName: nameById.get(r.profileId) ?? "—",
		})),
		lastFetched,
	};
}

export type PublishingInsights = Awaited<
	ReturnType<typeof getPublishingInsights>
>;

/**
 * Aggregated insights for the Publishing → Overview dashboard: volume, success
 * rate, week-over-week trend, per-platform / per-ecosystem / per-provider
 * breakdowns, a 14-day activity sparkline, engagement over the analytics-tracked
 * subset, upcoming scheduled posts, and the most recent published posts.
 *
 * Built mostly from posts_log (rich) with engagement layered from the sparse
 * analytics snapshots. One pass over the rows in memory — the volume here
 * (hundreds of rows) is well within a single query.
 */
export async function getPublishingInsights(user: AppUser) {
	const accessible = await getAccessibleProfiles(user);
	const empty = {
		hasAccess: accessible.length > 0,
		totals: { published: 0, failed: 0, scheduled: 0, publishing: 0 },
		successRate: null as number | null,
		week: { current: 0, previous: 0 },
		byPlatform: [] as { platform: string; count: number }[],
		byEcosystem: [] as { name: string; count: number }[],
		byProvider: { postpeer: 0, zernio: 0 },
		activity: [] as { label: string; count: number }[],
		engagement: {
			tracked: 0,
			views: 0,
			likes: 0,
			top: [] as { title: string; views: number; url: string | null }[],
		},
		upcoming: [] as {
			id: string;
			content: string | null;
			profileName: string;
			when: Date;
			platforms: { platform: string }[];
		}[],
		recent: [] as RecentPost[],
	};
	if (accessible.length === 0) return empty;

	const ids = accessible.map((p) => p.id);
	const nameById = new Map(accessible.map((p) => [p.id, p.name]));

	const [rows, snaps] = await Promise.all([
		db
			.select({
				id: postsLog.id,
				status: postsLog.status,
				platforms: postsLog.platforms,
				provider: postsLog.provider,
				profileId: postsLog.profileId,
				content: postsLog.content,
				publishedUrl: postsLog.publishedUrl,
				postpeerPostId: postsLog.postpeerPostId,
				createdAt: postsLog.createdAt,
				scheduledFor: postsLog.scheduledFor,
			})
			.from(postsLog)
			.where(inArray(postsLog.profileId, ids))
			.orderBy(desc(postsLog.createdAt)),
		db
			.select()
			.from(analyticsSnapshots)
			.where(inArray(analyticsSnapshots.profileId, ids)),
	]);

	const DAY = 86_400_000;
	const now = Date.now();
	const published = rows.filter((r) => r.status === "published");
	const failed = rows.filter((r) => r.status === "failed");
	const scheduled = rows.filter((r) => r.status === "scheduled");
	const publishing = rows.filter((r) => r.status === "publishing");

	const totals = {
		published: published.length,
		failed: failed.length,
		scheduled: scheduled.length,
		publishing: publishing.length,
	};
	const attempted = totals.published + totals.failed;
	const successRate = attempted ? totals.published / attempted : null;

	const inWindow = (
		r: (typeof published)[number],
		from: number,
		to: number,
	) => {
		const age = now - r.createdAt.getTime();
		return age >= from && age < to;
	};
	const week = {
		current: published.filter((r) => inWindow(r, 0, 7 * DAY)).length,
		previous: published.filter((r) => inWindow(r, 7 * DAY, 14 * DAY)).length,
	};

	const bump = (m: Map<string, number>, k: string, n = 1) =>
		m.set(k, (m.get(k) ?? 0) + n);
	const platformCounts = new Map<string, number>();
	const ecoCounts = new Map<string, number>();
	const byProvider = { postpeer: 0, zernio: 0 };
	for (const r of published) {
		for (const pt of r.platforms ?? []) bump(platformCounts, pt.platform);
		bump(ecoCounts, r.profileId);
		if (r.provider === "zernio") byProvider.zernio++;
		else byProvider.postpeer++;
	}
	const byPlatform = [...platformCounts.entries()]
		.map(([platform, count]) => ({ platform, count }))
		.sort((a, b) => b.count - a.count);
	const byEcosystem = [...ecoCounts.entries()]
		.map(([id, count]) => ({ name: nameById.get(id) ?? "—", count }))
		.sort((a, b) => b.count - a.count)
		.slice(0, 6);

	// 14-day daily activity (published).
	const activity: { label: string; count: number }[] = [];
	for (let i = 13; i >= 0; i--) {
		const dayStart = new Date(now - i * DAY);
		dayStart.setHours(0, 0, 0, 0);
		const start = dayStart.getTime();
		const count = published.filter(
			(r) =>
				r.createdAt.getTime() >= start && r.createdAt.getTime() < start + DAY,
		).length;
		activity.push({
			label: dayStart.toLocaleDateString(undefined, {
				month: "short",
				day: "numeric",
			}),
			count,
		});
	}

	// Engagement over the analytics-tracked subset.
	const contentById = new Map(
		published.map((r) => [r.postpeerPostId, r.content]),
	);
	let views = 0;
	let likes = 0;
	const engRows = snaps.map((s) => {
		const v = s.aggregated?.views ?? 0;
		const l = s.aggregated?.likes ?? 0;
		views += v;
		likes += l;
		const title = (contentById.get(s.postpeerPostId) ?? "").slice(0, 60);
		const url =
			s.platforms?.find((p) => p.platformPostUrl)?.platformPostUrl ?? null;
		return { title: title || "(untitled)", views: v, url };
	});
	const engagement = {
		tracked: snaps.length,
		views,
		likes,
		top: engRows.sort((a, b) => b.views - a.views).slice(0, 3),
	};

	const upcoming = scheduled
		.filter((r) => r.scheduledFor)
		.sort((a, b) => a.scheduledFor!.getTime() - b.scheduledFor!.getTime())
		.slice(0, 5)
		.map((r) => ({
			id: r.id,
			content: r.content,
			profileName: nameById.get(r.profileId) ?? "—",
			when: r.scheduledFor as Date,
			platforms: (r.platforms ?? []).map((p) => ({ platform: p.platform })),
		}));

	const recent: RecentPost[] = published.slice(0, 12).map((r) => ({
		id: r.id,
		content: r.content,
		platforms: r.platforms,
		profileName: nameById.get(r.profileId) ?? "—",
		createdAt: r.createdAt,
		status: r.status,
		publishedUrl: r.publishedUrl,
		metrics: null,
	}));
	// Attach engagement metrics to recent posts where tracked.
	const metricsById = new Map(
		snaps.map((s) => [
			s.postpeerPostId,
			{
				likes: s.aggregated?.likes ?? null,
				views: s.aggregated?.views ?? null,
			},
		]),
	);
	for (const p of published.slice(0, 12)) {
		const m = p.postpeerPostId ? metricsById.get(p.postpeerPostId) : null;
		if (m) {
			const target = recent.find((x) => x.id === p.id);
			if (target) target.metrics = m;
		}
	}

	return {
		hasAccess: true,
		totals,
		successRate,
		week,
		byPlatform,
		byEcosystem,
		byProvider,
		activity,
		engagement,
		upcoming,
		recent,
	};
}

type RecentPost = {
	id: string;
	content: string | null;
	platforms: (typeof postsLog.$inferSelect)["platforms"];
	profileName: string;
	createdAt: Date;
	status: string;
	publishedUrl: string | null;
	metrics: { likes: number | null; views: number | null } | null;
};

/** Admin: simple list of all ecosystems (for assignment pickers). */
export async function getEcosystemOptions() {
	const rows = await db
		.select({ id: profiles.id, name: profiles.name, teamName: teams.name })
		.from(profiles)
		.leftJoin(teams, eq(teams.id, profiles.teamId))
		.orderBy(profiles.createdAt);
	return rows.map((r) => ({
		id: r.id,
		name: r.name,
		teamName: r.teamName ?? "—",
	}));
}

/** Admin: every user with role, approval, and assigned ecosystems. */
export async function getAllMembers() {
	const allUsers = await db.select().from(users).orderBy(users.createdAt);

	// One query for all assignments, grouped in memory (avoids N+1).
	const assignments = await db
		.select({
			userId: ecosystemMembers.userId,
			id: profiles.id,
			name: profiles.name,
		})
		.from(ecosystemMembers)
		.innerJoin(profiles, eq(profiles.id, ecosystemMembers.profileId));
	const byUser = new Map<string, { id: string; name: string }[]>();
	for (const a of assignments) {
		const arr = byUser.get(a.userId) ?? [];
		arr.push({ id: a.id, name: a.name });
		byUser.set(a.userId, arr);
	}

	return allUsers.map((u) => ({
		id: u.id,
		email: u.email,
		name: u.name,
		role: u.role,
		approved: u.approved,
		pending: u.nandiSub.startsWith("pending:"),
		ecosystems: byUser.get(u.id) ?? [],
	}));
}
