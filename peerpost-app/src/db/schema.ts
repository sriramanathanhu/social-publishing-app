import { relations } from "drizzle-orm";
import {
	boolean,
	doublePrecision,
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
		// Avatar URL + KAILASA eCitizen id, pulled from Nandi SSO when available.
		image: text("image"),
		ecitizenId: text("ecitizen_id"),
		// Platform-level role. Admins manage teams, ecosystems, members.
		role: text("role").notNull().default("user"),
		// Anyone can sign in, but a user can only connect platforms / publish once
		// an admin has APPROVED them AND assigned them ecosystem(s). Admins are
		// always treated as approved regardless of this flag.
		approved: boolean("approved").notNull().default(false),
		// When true, every finished dub of this user auto-publishes to the accounts
		// mapped for its language (dub_autopublish_rules) — no per-dub opt-in.
		dubAutopublish: boolean("dub_autopublish").notNull().default(false),
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
		// When dubbed from a Library item: which one (so we can tag/link it).
		sourceLibraryId: text("source_library_id"),
		sourceLibraryKind: text("source_library_kind"), // "upload" | "short"
		// AI-generated per-platform captions: { instagram: {caption, title?}, ... }.
		captions: jsonb("captions").$type<Record<string, DubCaption>>(),
		// Auto-publish: when set, on completion the dub is scheduled to the
		// accounts mapped for its targetLang under this ecosystem's rules.
		autoPublishProfileId: uuid("auto_publish_profile_id"),
		autoPublishedAt: timestamp("auto_published_at", { withTimezone: true }),
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
 * Saved auto-publish routing: per ecosystem, which connected accounts a dub of a
 * given target language should auto-schedule to when it finishes. Set up once;
 * every opted-in dub of that language routes by it.
 */
export const dubAutopublishRules = pgTable(
	"dub_autopublish_rules",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		lang: text("lang").notNull(), // dub target code, e.g. "hi"
		accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
		// Delay before the FIRST post of a batch: schedule = dub-done + buffer.
		bufferMinutes: integer("buffer_minutes").notNull().default(30),
		// Drip: minimum spacing between consecutive auto-posts to these accounts.
		// 0 = no spacing (each posts at its own buffer). >0 staggers a batch so it
		// doesn't flood — each post lands at least gapMinutes after the previous.
		gapMinutes: integer("gap_minutes").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		index("dub_autopublish_profile_idx").on(t.profileId),
		uniqueIndex("dub_autopublish_profile_lang").on(t.profileId, t.lang),
	],
);

/**
 * Quote-card auto-publish rules. Separate from dub rules (quotes may target
 * different accounts than dubbed reels). Per ecosystem: which image-capable
 * accounts a quote of a given language ("Hindi", "Tamil", …) is scheduled to,
 * with the same buffer (first-post delay) + gap (drip spacing) as dubs.
 */
export const quoteAutopublishRules = pgTable(
	"quote_autopublish_rules",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		lang: text("lang").notNull(), // quote output-language label, e.g. "Hindi"
		accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
		bufferMinutes: integer("buffer_minutes").notNull().default(30),
		gapMinutes: integer("gap_minutes").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		index("quote_autopublish_profile_idx").on(t.profileId),
		uniqueIndex("quote_autopublish_profile_lang").on(t.profileId, t.lang),
	],
);

/**
 * A reusable "distribution list": a named set of target accounts spanning ANY
 * ecosystems. Used to SPREAD a freshly-generated pool of single-language cards
 * across many channels — each target gets a distinct slice of `cardsPerTarget`
 * cards (no repeats), drip-scheduled by buffer + gap. Distinct from the
 * broadcast rules, which send the same card to all of a language's accounts.
 */
export const quoteDistributions = pgTable(
	"quote_distributions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		lang: text("lang").notNull().default("English"),
		// How many distinct cards each target account receives.
		cardsPerTarget: integer("cards_per_target").notNull().default(10),
		bufferMinutes: integer("buffer_minutes").notNull().default(30),
		gapMinutes: integer("gap_minutes").notNull().default(60),
		// The target accounts (across ecosystems): [{profileId, accountId}].
		targets: jsonb("targets")
			.$type<{ profileId: string; accountId: string }[]>()
			.notNull()
			.default([]),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("quote_distributions_user_idx").on(t.userId)],
);

/**
 * Reusable distribution list for SHORTS (videos). Mirrors quote_distributions:
 * a named set of target accounts spanning any ecosystems; "Auto-publish" a
 * shorts job into it spreads the generated clips so each ecosystem gets a
 * distinct slice of `shortsPerTarget` clips, broadcast to its selected
 * accounts, drip-scheduled by buffer + gap.
 */
export const shortsDistributions = pgTable(
	"shorts_distributions",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		// How many distinct clips each ecosystem receives.
		shortsPerTarget: integer("shorts_per_target").notNull().default(10),
		bufferMinutes: integer("buffer_minutes").notNull().default(30),
		gapMinutes: integer("gap_minutes").notNull().default(60),
		targets: jsonb("targets")
			.$type<{ profileId: string; accountId: string }[]>()
			.notNull()
			.default([]),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("shorts_distributions_user_idx").on(t.userId)],
);

/**
 * Language→accounts rules for long-form TEXT auto-publishing (articles &
 * transcripts), keyed by `kind` so each page has its own separate rules. After
 * generating, the user translates the piece into chosen languages and each
 * translation is broadcast to that language's mapped accounts (text post).
 */
export const textAutopublishRules = pgTable(
	"text_autopublish_rules",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		profileId: uuid("profile_id")
			.notNull()
			.references(() => profiles.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(), // "article" | "transcript"
		lang: text("lang").notNull(), // language label, e.g. "Hindi"
		accountIds: jsonb("account_ids").$type<string[]>().notNull().default([]),
		bufferMinutes: integer("buffer_minutes").notNull().default(30),
		gapMinutes: integer("gap_minutes").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		index("text_autopublish_profile_idx").on(t.profileId),
		uniqueIndex("text_autopublish_profile_kind_lang").on(
			t.profileId,
			t.kind,
			t.lang,
		),
	],
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
		// User-supplied name for the job (shown + linked in the table).
		name: text("name"),
		status: dubJobStatusEnum("status").notNull().default("queued"),
		sourceType: text("source_type").notNull(), // "url" | "upload"
		sourceInput: text("source_input").notNull(),
		pct: integer("pct").notNull().default(0),
		stage: text("stage"),
		message: text("message"),
		// Requested clip count + render settings (aspect, min/max seconds, language).
		numClips: integer("num_clips").notNull().default(15),
		settings: jsonb("settings").$type<Record<string, unknown>>(),
		// Opt-in: spread this job's finished clips into a shorts distribution list.
		autoPublishDistributionId: uuid("auto_publish_distribution_id"),
		// Clip idxs already auto-published — kept on the JOB (not the clips, which
		// the sync cron deletes + re-inserts every run) so we never double-post.
		autoPublishedIdxs: jsonb("auto_published_idxs")
			.$type<number[]>()
			.notNull()
			.default([]),
		error: text("error"),
		// Set when the job reaches a terminal state (for "time taken").
		completedAt: timestamp("completed_at", { withTimezone: true }),
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

/**
 * Curated background photos for Quote image cards. Admins upload; anyone making
 * a card can pick one (or upload their own per-card). Stored in R2.
 */
export const quoteBackgrounds = pgTable("quote_backgrounds", {
	id: uuid("id").defaultRandom().primaryKey(),
	label: text("label"),
	r2Key: text("r2_key").notNull(),
	url: text("url").notNull(),
	createdByUserId: uuid("created_by_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

/** Curated overlay PNGs (brand frames) for Quote cards. */
export const quoteOverlays = pgTable("quote_overlays", {
	id: uuid("id").defaultRandom().primaryKey(),
	label: text("label"),
	r2Key: text("r2_key").notNull(),
	url: text("url").notNull(),
	isDefault: boolean("is_default").notNull().default(false),
	createdByUserId: uuid("created_by_user_id").references(() => users.id, {
		onDelete: "set null",
	}),
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
});

/**
 * Persisted generated quotes + their rendered cards, so a user's work survives a
 * refresh. One row per quote; the card fields fill in once a card is rendered.
 */
export const quoteItems = pgTable(
	"quote_items",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		text: text("text").notNull(),
		hashtags: jsonb("hashtags").$type<string[]>().default([]),
		// Groups quotes made in the same generation call (batch segregation).
		batchId: text("batch_id"),
		// Output language chosen at generation (label, e.g. "Hindi"); null = default.
		outputLang: text("output_lang"),
		// Card composition (filled when a card is made).
		bgUrl: text("bg_url"),
		overlayUrl: text("overlay_url"),
		cardUrl: text("card_url"),
		panY: doublePrecision("pan_y").notNull().default(0.4),
		zoom: doublePrecision("zoom").notNull().default(1),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("quote_items_user_idx").on(t.userId)],
);

/** Grounded long-form articles generated from the Vertex AI Search corpus. */
export const articles = pgTable(
	"articles",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		topic: text("topic").notNull(),
		title: text("title"),
		// Markdown body of the article.
		content: text("content").notNull().default(""),
		// Source files the article was grounded on: [{n, file, uri}].
		citations: jsonb("citations")
			.$type<{ n: number; file: string; uri: string }[]>()
			.default([]),
		provider: text("provider"),
		// Output language chosen at generation (label, e.g. "Hindi"); null = default.
		outputLang: text("output_lang"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("articles_user_idx").on(t.userId)],
);

/** Audio → chunked Gemini transcription jobs (optionally translated). The
 * finished transcript can be pushed to the GCS corpus + re-ingested by Vertex. */
export const transcriptJobs = pgTable(
	"transcript_jobs",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull().default("Untitled"),
		sourceType: text("source_type").notNull(), // "upload" | "drive"
		sourceInput: text("source_input").notNull(), // audio URL or Drive link
		chunks: integer("chunks").notNull().default(4),
		sourceLang: text("source_lang").notNull().default("English"),
		outputLang: text("output_lang").notNull().default("English"),
		translate: boolean("translate").notNull().default(false),
		dubberJobId: text("dubber_job_id"),
		status: dubJobStatusEnum("status").notNull().default("queued"),
		pct: integer("pct").notNull().default(0),
		stage: text("stage"),
		message: text("message"),
		transcript: text("transcript"),
		error: text("error"),
		// Corpus push: the GCS object key + when it was last ingested by Vertex.
		corpusKey: text("corpus_key"),
		pushedAt: timestamp("pushed_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("transcript_jobs_user_idx").on(t.userId)],
);

/** User-uploaded videos (e.g. manually-edited shorts) kept in R2 and surfaced
 * in the Library alongside generated shorts clips. */
export const userVideos = pgTable(
	"user_videos",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		title: text("title").notNull().default("Untitled"),
		r2Key: text("r2_key").notNull(),
		url: text("url").notNull(),
		contentType: text("content_type"),
		sizeBytes: integer("size_bytes"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [index("user_videos_user_idx").on(t.userId)],
);

/** Free-form user tags on any Library item (keyed by kind + itemId, so no
 * per-table columns). Used to group/filter content across the Library. */
export const contentTags = pgTable(
	"content_tags",
	{
		id: uuid("id").defaultRandom().primaryKey(),
		userId: uuid("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		// kind: background|overlay|video|short|dub|quote|article|transcript
		kind: text("kind").notNull(),
		itemId: text("item_id").notNull(),
		tag: text("tag").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(t) => [
		index("content_tags_item_idx").on(t.kind, t.itemId),
		index("content_tags_user_idx").on(t.userId),
	],
);
