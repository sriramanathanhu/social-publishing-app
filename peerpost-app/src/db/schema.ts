import { relations } from "drizzle-orm";
import {
	boolean,
	index,
	integer,
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
	// Added with the Zernio provider (platforms PostPeer doesn't cover).
	"reddit",
	"telegram",
	"discord",
	"whatsapp",
	"snapchat",
	"googlebusiness",
]);

/** Which upstream publishing API owns an account / published a post. */
export const providerEnum = pgEnum("provider", ["postpeer", "zernio"]);

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

/** Lifecycle of a video dubbing job run by the dubber-service sidecar. */
export const dubJobStatusEnum = pgEnum("dub_job_status", [
	"queued",
	"running",
	"awaiting_review", // captions generated, awaiting user edit/approval (Phase 2)
	"done",
	"failed",
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
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
	},
	(t) => [uniqueIndex("users_nandi_sub_idx").on(t.nandiSub)],
);

/**
 * Personal API keys for the MCP server. The raw key is shown once at creation;
 * only its SHA-256 hash is stored. A key inherits its owner's ecosystem access
 * (admins = all). Used by Claude (via the MCP OAuth/token flow) to act as the
 * user when publishing.
 */
export const apiKeys = pgTable(
	"api_keys",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		label: text("label").notNull(),
		keyHash: text("key_hash").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
		expiresAt: timestamp("expires_at", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("api_keys_hash_idx").on(t.keyHash),
		index("api_keys_user_idx").on(t.userId),
	],
);

/** A team groups ecosystems (admin-created organisational container). */
export const teams = pgTable("teams", {
	id: uuid("id").defaultRandom().primaryKey(),
	name: text("name").notNull(),
	description: text("description"),
	createdByUserId: uuid("created_by_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
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
		addedAt: timestamp("added_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
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
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
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
		// Which upstream API this account lives in (postpeer | zernio). Routing
		// in the publish path uses this to pick the right client per account.
		provider: providerEnum("provider").notNull().default("postpeer"),
		platform: platformEnum("platform").notNull(),
		// The provider's account id — what POST /posts targets (PostPeer integration
		// id, or Zernio account `_id`). Column name kept for migration safety.
		postpeerAccountId: text("postpeer_account_id").notNull(),
		// For Zernio, the account's OWN profile id. Zernio groups can span profiles,
		// so this is stored per-account and used (over the ecosystem mapping) when
		// publishing. Null for PostPeer (which doesn't need it).
		externalProfileId: text("external_profile_id"),
		handle: text("handle"),
		displayName: text("display_name"),
		status: integrationStatusEnum("status").notNull().default("connected"),
		// Whether this account is usable for posting. PostPeer's OAuth imports
		// EVERY page an account manages (e.g. 200 Facebook pages); the user picks
		// which are active. Non-destructive — survives reconnects (sync preserves
		// it) unlike disconnecting, which PostPeer would re-import on next connect.
		active: boolean("active").notNull().default(true),
		connectedByUserId: uuid("connected_by_user_id").references(() => users.id, {
			onDelete: "set null",
		}),
		syncedAt: timestamp("synced_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		index("integrations_profile_idx").on(t.profileId),
		uniqueIndex("integrations_account_idx").on(t.postpeerAccountId),
	],
);

/**
 * Maps one of our ecosystems (profiles.id) to its external profile id in a
 * given provider. An ecosystem can hold accounts from multiple providers, so it
 * may have one row per provider here. PostPeer's mapping also lives in
 * profiles.postpeerProfileId (legacy); this table is the general home and the
 * sole place Zernio's profile id is stored.
 */
export const providerProfiles = pgTable(
	"provider_profiles",
	{
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		provider: providerEnum("provider").notNull(),
		// The provider's own profile id (Zernio profile `_id`, PostPeer profile id).
		externalProfileId: text("external_profile_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [primaryKey({ columns: [t.profileId, t.provider] })],
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
		// Which provider published this post, and its post id there.
		provider: providerEnum("provider").notNull().default("postpeer"),
		postpeerPostId: text("postpeer_post_id"),
		// Public link to the published content on the platform (e.g. the tweet /
		// reel URL), fetched from the provider once it finishes publishing.
		publishedUrl: text("published_url"),
		status: postStatusEnum("status").notNull().default("draft"),
		// Where the post was composed: "dub" (a dubbed video), "short" (a shorts
		// clip), or "composer" (the manual composer). Null on historical rows.
		source: text("source"),
		content: text("content"),
		// Snapshot of the platform targets sent to PostPeer.
		platforms: jsonb("platforms").$type<PostPlatformTarget[]>(),
		scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
		timezone: text("timezone"),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
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
		fetchedAt: timestamp("fetched_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("analytics_profile_idx").on(t.profileId)],
);

export const usersRelations = relations(users, ({ many }) => ({
	ecosystemMemberships: many(ecosystemMembers),
}));

export const teamsRelations = relations(teams, ({ many }) => ({
	profiles: many(profiles),
}));

export const ecosystemMembersRelations = relations(
	ecosystemMembers,
	({ one }) => ({
		profile: one(profiles, {
			fields: [ecosystemMembers.profileId],
			references: [profiles.id],
		}),
		user: one(users, {
			fields: [ecosystemMembers.userId],
			references: [users.id],
		}),
	}),
);

export const profilesRelations = relations(profiles, ({ one, many }) => ({
	team: one(teams, {
		fields: [profiles.teamId],
		references: [teams.id],
	}),
	members: many(ecosystemMembers),
	integrations: many(integrationsCache),
}));

export const integrationsRelations = relations(
	integrationsCache,
	({ one }) => ({
		profile: one(profiles, {
			fields: [integrationsCache.profileId],
			references: [profiles.id],
		}),
	}),
);

/**
 * Per-user, bring-your-own API keys for the dubbing pipeline (Deepgram for
 * transcription, Gemini for translation/vision, NVIDIA NIM for captions +
 * Shorts). Values are stored ENCRYPTED at rest (AES-256-GCM, see lib/crypto.ts)
 * and only decrypted server-side at job-dispatch time to pass to the
 * dubber-service. The shared PostPeer key is NOT here — that's env config.
 */
export const userApiKeys = pgTable("user_api_keys", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	// Ciphertext blobs (null = not set). Never exposed to the client.
	deepgramKeyEnc: text("deepgram_key_enc"),
	geminiKeyEnc: text("gemini_key_enc"),
	// NVIDIA NIM key: Shorts clip-finding/titles (Kimi/Llama) + Dub AI captions.
	nvidiaKeyEnc: text("nvidia_key_enc"),
	// Encrypted yt-dlp cookies.txt (Netscape format) for login/rate-limited
	// sources (Instagram, YouTube on a server IP). Passed per-job, never shown.
	cookiesEnc: text("cookies_enc"),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

export type DubCaption = { caption: string; title?: string };

/**
 * A video dubbing job. Mirrors the dubber-service job (`dubberJobId`) and adds
 * the ownership / RBAC layer PeerPost owns. On completion the dubbed video is
 * uploaded via the existing media flow and handed to the composer (Phase 2).
 */
export const dubJobs = pgTable(
	"dub_jobs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// Optional target ecosystem the dubbed video will publish under (Phase 2).
		profileId: uuid("profile_id").references(() => profiles.id, {
			onDelete: "set null",
		}),
		// The job id returned by the dubber-service (POST /jobs).
		dubberJobId: text("dubber_job_id"),
		status: dubJobStatusEnum("status").notNull().default("queued"),
		// "url" | "upload" — how the source arrived.
		sourceType: text("source_type").notNull(),
		sourceInput: text("source_input").notNull(), // URL or stored upload ref
		sourceLang: text("source_lang").notNull().default("auto"),
		targetLang: text("target_lang").notNull(),
		voice: text("voice").notNull(),
		pct: integer("pct").notNull().default(0),
		stage: text("stage"),
		message: text("message"),
		// PostPeer publicUrl of the finished dub once uploaded (Phase 2 handoff).
		outputUrl: text("output_url"),
		// R2 object key of the durable archive copy (e.g. "dubs/<id>.mp4"), set
		// once on completion. Backup only — publishing uses outputUrl/PostPeer.
		archiveKey: text("archive_key"),
		// AI-generated per-platform captions: { instagram: {caption, title?}, ... }.
		captions: jsonb("captions").$type<Record<string, DubCaption>>(),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("dub_jobs_user_idx").on(t.userId)],
);

/**
 * A "long video → shorts" job run by the shorts pipeline in the dubber-service:
 * download → transcribe → AI clip-find → extract 9:16 → upload clips to R2.
 * Mirrors dub_jobs (status/pct/SSE) but yields MANY clips (shorts_clips).
 */
export const shortsJobs = pgTable(
	"shorts_jobs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// The job id returned by the dubber-service (POST /shorts).
		shortsJobId: text("shorts_job_id"),
		status: dubJobStatusEnum("status").notNull().default("queued"),
		sourceType: text("source_type").notNull(), // "url" | "upload"
		sourceInput: text("source_input").notNull(),
		pct: integer("pct").notNull().default(0),
		stage: text("stage"),
		message: text("message"),
		// Requested clip count + render settings (aspect, min/max seconds, language).
		numClips: integer("num_clips").notNull().default(15),
		settings: jsonb("settings").$type<Record<string, unknown>>(),
		error: text("error"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("shorts_jobs_user_idx").on(t.userId)],
);

/** One generated short clip: its R2 video + AI title/description metadata. */
export const shortsClips = pgTable(
	"shorts_clips",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		jobId: uuid("job_id")
			.notNull()
			.references(() => shortsJobs.id, { onDelete: "cascade" }),
		idx: integer("idx").notNull(), // 1-based order within the job
		title: text("title"),
		description: text("description"),
		hashtags: jsonb("hashtags").$type<string[]>(),
		startSec: integer("start_sec"),
		endSec: integer("end_sec"),
		durationSec: integer("duration_sec"),
		viralScore: integer("viral_score"),
		// R2 object key + public (custom-domain) URL of the rendered clip.
		r2Key: text("r2_key"),
		publicUrl: text("public_url"),
		// Publish state once handed to the composer (draft until published).
		status: postStatusEnum("status").notNull().default("draft"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("shorts_clips_job_idx").on(t.jobId)],
);

/**
 * Per-user reusable Shorts render assets (public URLs). Applied to every clip
 * in a job when set: a full-frame overlay PNG, a transition clip, and an
 * end-card clip appended after each short.
 */
export const userAssets = pgTable("user_assets", {
	userId: uuid("user_id")
		.primaryKey()
		.references(() => users.id, { onDelete: "cascade" }),
	overlayUrl: text("overlay_url"),
	transitionUrl: text("transition_url"),
	endcardUrl: text("endcard_url"),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});
