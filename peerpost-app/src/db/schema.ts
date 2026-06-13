import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	jsonb,
	pgEnum,
	pgTable,
	primaryKey,
	text,
	timestamp,
	uniqueIndex,
	uuid,
} from "drizzle-orm/pg-core";

/**
 * Data model for the PostPeer wrapper.
 *
 * PostPeer itself only knows about `profiles`, `integrations` and `posts` under
 * a single API key. It has no concept of *our* users or who may act on a
 * profile. Everything in this file is the multi-tenant / RBAC layer we own.
 *
 *   profile_members  → many-to-many between users and profiles (reqs #3 & #4)
 *   integrations_cache → local mirror of PostPeer integrations for fast lookup
 *   posts_log        → audit trail of what each user published/scheduled
 */

export const platformEnum = pgEnum("platform", [
	"twitter",
	"youtube",
	"linkedin",
	"pinterest",
	"bluesky",
	"tiktok",
	"instagram",
	"facebook",
	"threads",
]);


export const integrationStatusEnum = pgEnum("integration_status", [
	"connected",
	"disconnected",
	"error",
]);

export const postStatusEnum = pgEnum("post_status", [
	"draft",
	"scheduled",
	"publishing",
	"published",
	"failed",
	"cancelled",
]);

/** Our users, provisioned just-in-time from the Nandi SSO session. */
export const users = pgTable(
	"users",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		// Stable identifier from Nandi (`sub`). The source of truth for matching.
		nandiSub: text("nandi_sub").notNull(),
		email: text("email"),
		name: text("name"),
		// Platform-level role. Admins manage teams, ecosystems, members.
		role: text("role").notNull().default("user"),
		// Anyone can sign in, but a user can only connect platforms / publish once
		// an admin has APPROVED them AND assigned them ecosystem(s). Admins are
		// always treated as approved regardless of this flag.
		approved: boolean("approved").notNull().default(false),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
	},
	(t) => [uniqueIndex("users_nandi_sub_idx").on(t.nandiSub)],
);

/** A team groups ecosystems (admin-created organisational container). */
export const teams = pgTable("teams", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	createdByUserId: uuid("created_by_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * M:N assignment of users to ecosystems (profiles) — the unit of access.
 * One user ↔ many ecosystems and one ecosystem ↔ many users. Admins assign
 * these (only to approved users); access to connect/publish flows from here.
 */
export const ecosystemMembers = pgTable(
	"ecosystem_members",
	{
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		addedAt: timestamp("added_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [primaryKey({ columns: [t.profileId, t.userId] })],
);

/** A profile is a 1:1 mirror of a PostPeer profile, scoped to a team. */
export const profiles = pgTable(
	"profiles",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		teamId: uuid("team_id").references(() => teams.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		description: text("description"),
		// The id returned by POST /v1/profiles/ — used on every PostPeer call.
		postpeerProfileId: text("postpeer_profile_id").notNull(),
		createdByUserId: uuid("created_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("profiles_team_idx").on(t.teamId)],
);

/** Local mirror of PostPeer integrations (one connected social account each). */
export const integrationsCache = pgTable(
	"integrations_cache",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		platform: platformEnum("platform").notNull(),
		// accountId from PostPeer — this is what POST /posts targets.
		postpeerAccountId: text("postpeer_account_id").notNull(),
		handle: text("handle"),
		displayName: text("display_name"),
		status: integrationStatusEnum("status").notNull().default("connected"),
		connectedByUserId: uuid("connected_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		syncedAt: timestamp("synced_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [
		index("integrations_profile_idx").on(t.profileId),
		uniqueIndex("integrations_account_idx").on(t.postpeerAccountId),
	],
);

/** Audit trail of publish/schedule actions through the wrapper. */
export const postsLog = pgTable(
	"posts_log",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		authorUserId: uuid("author_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		postpeerPostId: text("postpeer_post_id"),
		status: postStatusEnum("status").notNull().default("draft"),
		content: text("content"),
		// Snapshot of the platform targets sent to PostPeer.
		platforms: jsonb("platforms").$type<PostPlatformTarget[]>(),
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
		timezone: text("timezone"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("posts_log_profile_idx").on(t.profileId)],
);

export type PostPlatformTarget = {
	platform: string;
	accountId: string;
	content?: string;
};

export type AnalyticsMetrics = {
	impressions: number | null;
	reach: number | null;
	likes: number | null;
	comments: number | null;
	shares: number | null;
	saves: number | null;
	clicks: number | null;
	views: number | null;
	engagementRate: number | null;
};

export type AnalyticsPlatformEntry = {
	platform: string;
	platformPostUrl: string | null;
	metrics: AnalyticsMetrics;
};

/**
 * Cached PostPeer analytics (one row per published post). PostPeer only exposes
 * post-level metrics and charges 1 credit/call, so we snapshot here and refresh
 * on a schedule / on demand rather than fetching live per page-view.
 */
export const analyticsSnapshots = pgTable(
	"analytics_snapshots",
	{
		postpeerPostId: text("postpeer_post_id").primaryKey(),
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		content: text("content"),
		publishedAt: timestamp("published_at", { withTimezone: true }),
		aggregated: jsonb("aggregated").$type<AnalyticsMetrics>(),
		platforms: jsonb("platforms").$type<AnalyticsPlatformEntry[]>(),
		fetchedAt: timestamp("fetched_at", { withTimezone: true }).defaultNow().notNull(),
	},
	(t) => [index("analytics_profile_idx").on(t.profileId)],
);

export const usersRelations = relations(users, ({ many }) => ({
	ecosystemMemberships: many(ecosystemMembers),
}));

export const teamsRelations = relations(teams, ({ many }) => ({
	profiles: many(profiles),
}));

export const ecosystemMembersRelations = relations(ecosystemMembers, ({ one }) => ({
	profile: one(profiles, {
		fields: [ecosystemMembers.profileId],
		references: [profiles.id],
	}),
	user: one(users, {
		fields: [ecosystemMembers.userId],
		references: [users.id],
	}),
}));

export const profilesRelations = relations(profiles, ({ one, many }) => ({
	team: one(teams, {
		fields: [profiles.teamId],
		references: [teams.id],
	}),
	members: many(ecosystemMembers),
	integrations: many(integrationsCache),
}));

export const integrationsRelations = relations(integrationsCache, ({ one }) => ({
	profile: one(profiles, {
		fields: [integrationsCache.profileId],
		references: [profiles.id],
	}),
}));
