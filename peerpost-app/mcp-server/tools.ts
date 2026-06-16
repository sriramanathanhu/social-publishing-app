import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { and, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
	type AuthContext,
	accessibleProfiles,
	getAuth,
	requireProfile,
} from "./auth";
import { db, schema } from "./db";
import {
	downloadDriveFile,
	driveEnabled,
	listFolderMedia,
	parseDriveUrl,
} from "./drive";
import { type MediaItem, postpeer } from "./postpeer";

const { analyticsSnapshots, integrationsCache, postsLog } = schema;

/**
 * What each platform supports via the MCP — single source of truth for routing.
 * 'text' = caption-only post; 'image'/'video' = that media type. YouTube/TikTok
 * are video-only; Pinterest needs a board (web app only) so it's left empty.
 */
export type Capability = "text" | "image" | "video";
const PLATFORM_CAPS: Record<string, Partial<Record<Capability, boolean>>> = {
	twitter: { text: true, image: true, video: true },
	linkedin: { text: true, image: true, video: true },
	facebook: { text: true, image: true, video: true },
	bluesky: { text: true, image: true, video: true },
	threads: { text: true, image: true, video: true },
	instagram: { image: true, video: true },
	youtube: { video: true },
	tiktok: { video: true },
	pinterest: {},
};
export const supports = (platform: string, cap: Capability): boolean =>
	PLATFORM_CAPS[platform]?.[cap] === true;
const CHAR_LIMIT: Record<string, number> = { twitter: 280, bluesky: 300 };

async function connectedAccounts(profileId: string) {
	// Only ACTIVE accounts are postable. A connect can import hundreds of pages;
	// the user marks which are active in the app (Connected Accounts → Manage).
	return db
		.select({
			platform: integrationsCache.platform,
			accountId: integrationsCache.postpeerAccountId,
			handle: integrationsCache.handle,
		})
		.from(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, profileId),
				eq(integrationsCache.active, true),
			),
		);
}

type Target = { platform: string; accountId: string; handle: string | null };

/**
 * Resolve specific connected ACCOUNTS by their accountId. A platform can have
 * many accounts in one ecosystem (e.g. several LinkedIn pages), so targeting is
 * always per-account, never by platform name. `hasMedia` widens the set of
 * supported platforms (e.g. Instagram needs media; others accept it too).
 */
async function resolveTargets(
	profileId: string,
	accountIds: string[],
	hasMedia: boolean,
) {
	const accounts = await connectedAccounts(profileId);
	const byId = new Map(accounts.map((a) => [a.accountId, a]));
	const cap: Capability = hasMedia ? "image" : "text";
	const targets: Target[] = [];
	const problems: string[] = [];
	for (const id of accountIds) {
		const a = byId.get(id);
		if (!a) {
			problems.push(`${id}: not a connected account on this ecosystem`);
			continue;
		}
		if (!supports(a.platform, cap)) {
			const why = hasMedia
				? "image posting not supported here yet — use the web app for Pinterest/TikTok/YouTube"
				: a.platform === "instagram"
					? "needs an image/video — add a mediaUrl"
					: "not a text platform";
			problems.push(`${a.handle ?? id} (${a.platform}): ${why}`);
			continue;
		}
		targets.push({
			platform: a.platform,
			accountId: a.accountId,
			handle: a.handle,
		});
	}
	return { targets, problems };
}

function checkContent(content: string, targets: Target[]): string[] {
	const warns: string[] = [];
	for (const t of targets) {
		const lim = CHAR_LIMIT[t.platform];
		if (lim && content.length > lim)
			warns.push(
				`${t.handle ?? t.platform}: content is ${content.length} chars (limit ${lim})`,
			);
	}
	return warns;
}

const ok = (data: unknown) => JSON.stringify(data, null, 2);

// ── Tool handlers ────────────────────────────────────────────────────────────

async function listEcosystems(ctx: AuthContext) {
	const profiles = await accessibleProfiles(ctx);
	const out = await Promise.all(
		profiles.map(async (p) => {
			const accts = await connectedAccounts(p.id);
			return {
				id: p.id,
				name: p.name,
				team: p.teamName,
				// Each account is distinct (a platform may have several). Target by accountId.
				accounts: accts.map((a) => ({
					accountId: a.accountId,
					platform: a.platform,
					handle: a.handle,
				})),
			};
		}),
	);
	return ok({ ecosystems: out });
}

async function listAccounts(ctx: AuthContext, ecosystemId: string) {
	await requireProfile(ctx, ecosystemId);
	const accts = await connectedAccounts(ecosystemId);
	return ok({
		ecosystemId,
		accounts: accts.map((a) => ({
			accountId: a.accountId,
			platform: a.platform,
			handle: a.handle,
			textCapable: supports(a.platform, "text"),
		})),
	});
}

async function previewPost(
	ctx: AuthContext,
	ecosystemId: string,
	accountIds: string[],
	content: string,
	mediaUrls: string[],
	mediaBase64: string[],
) {
	const profile = await requireProfile(ctx, ecosystemId);
	const mediaCount = mediaUrls.length + mediaBase64.length;
	const hasMedia = mediaCount > 0;
	const { targets, problems } = await resolveTargets(
		ecosystemId,
		accountIds,
		hasMedia,
	);
	const warnings = [...problems, ...checkContent(content, targets)];
	return ok({
		ecosystem: profile.name,
		willPostTo: targets.map((t) => ({
			accountId: t.accountId,
			platform: t.platform,
			handle: t.handle,
		})),
		content,
		media: mediaCount,
		warnings,
		note: hasMedia ? "Media will be uploaded when you publish." : undefined,
		ready: targets.length > 0,
	});
}

type PayloadPlatform = {
	platform: string;
	accountId: string;
	platformSpecificData?: Record<string, unknown>;
};

/**
 * Build uploaded mediaItems from URLs and/or base64. A Drive FOLDER link lists
 * every image/video inside it; a private Drive FILE downloads via the API;
 * other URLs are fetched publicly; base64 entries (incl. data URIs) are the
 * bytes of a GENERATED image the model holds with no public URL.
 */
async function collectMedia(
	mediaUrls: string[],
	mediaBase64: string[],
): Promise<MediaItem[]> {
	const items: MediaItem[] = [];
	for (const b64 of mediaBase64) {
		items.push(await postpeer.uploadBase64(b64));
	}
	for (const url of mediaUrls) {
		const drive = parseDriveUrl(url);
		if (drive?.kind === "folder") {
			if (!driveEnabled()) {
				throw new Error(
					"Drive folder links need the Google Drive service account configured on the server.",
				);
			}
			const files = await listFolderMedia(drive.id);
			if (files.length === 0) {
				throw new Error(
					"No images/videos found in that Drive folder (or it isn't shared with the service account).",
				);
			}
			for (const f of files) {
				const dl = await downloadDriveFile(f.id);
				items.push(await postpeer.uploadBytes(dl.bytes, dl.mimeType, dl.name));
			}
		} else if (drive?.kind === "file" && driveEnabled()) {
			const dl = await downloadDriveFile(drive.id);
			items.push(await postpeer.uploadBytes(dl.bytes, dl.mimeType, dl.name));
		} else {
			items.push(await postpeer.uploadFromUrl(url));
		}
	}
	return items;
}

/** Create one PostPeer post (its own posts_log row); returns its id. Throws on failure. */
async function doPost(
	ctx: AuthContext,
	ecosystemId: string,
	content: string,
	payloadPlatforms: PayloadPlatform[],
	mediaItems: MediaItem[],
	scheduledFor: string | undefined,
	timezone: string | undefined,
): Promise<string | null> {
	const isScheduled = !!scheduledFor;
	const [logRow] = await db
		.insert(postsLog)
		.values({
			profileId: ecosystemId,
			authorUserId: ctx.userId,
			status: isScheduled ? "scheduled" : "publishing",
			content,
			platforms: payloadPlatforms,
			scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
			timezone: timezone ?? null,
		})
		.returning();
	try {
		const result = await postpeer.createPost({
			content,
			platforms: payloadPlatforms,
			mediaItems: mediaItems.length ? mediaItems : undefined,
			publishNow: isScheduled ? undefined : true,
			scheduledFor,
			timezone: timezone ?? (isScheduled ? "UTC" : undefined),
		});
		const postpeerPostId = result.postId ?? null;
		if (!result.success) {
			const detail =
				(result.platforms ?? [])
					.filter((p) => !p.success)
					.map((p) => `${p.platform}: ${p.error ?? "failed"}`)
					.join("; ") ||
				result.message ||
				"Publishing failed";
			await db
				.update(postsLog)
				.set({ status: "failed", postpeerPostId, error: detail })
				.where(eq(postsLog.id, logRow.id));
			throw new Error(detail);
		}
		await db
			.update(postsLog)
			.set({ status: isScheduled ? "scheduled" : "published", postpeerPostId })
			.where(eq(postsLog.id, logRow.id));
		return postpeerPostId;
	} catch (err) {
		await db
			.update(postsLog)
			.set({
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			})
			.where(eq(postsLog.id, logRow.id));
		throw err;
	}
}

type VideoOpts = {
	title?: string;
	visibility?: string;
	privacyLevel?: string;
};

/**
 * Resolve which accounts a video should go to. Default = ALL connected
 * video-capable accounts; narrow by `platforms` and/or `accountIds`.
 */
async function resolveVideoTargets(
	profileId: string,
	accountIds: string[] | undefined,
	platforms: string[] | undefined,
) {
	const accounts = await connectedAccounts(profileId);
	const problems: string[] = [];

	if (accountIds?.length) {
		const byId = new Map(accounts.map((a) => [a.accountId, a]));
		const targets: Target[] = [];
		for (const id of accountIds) {
			const a = byId.get(id);
			if (!a) {
				problems.push(`${id}: not a connected account`);
			} else if (!supports(a.platform, "video")) {
				problems.push(
					`${a.handle ?? id} (${a.platform}): not video-capable here`,
				);
			} else {
				targets.push({
					platform: a.platform,
					accountId: a.accountId,
					handle: a.handle,
				});
			}
		}
		return { targets, problems };
	}

	let pool = accounts.filter((a) => supports(a.platform, "video"));
	if (platforms?.length) {
		const set = new Set(platforms);
		pool = pool.filter((a) => set.has(a.platform));
	}
	return {
		targets: pool.map((a) => ({
			platform: a.platform,
			accountId: a.accountId,
			handle: a.handle,
		})),
		problems,
	};
}

/** Per-platform options for a video post (YouTube title, TikTok privacy, …). */
export function videoPlatformData(
	platform: string,
	content: string,
	opts: VideoOpts,
): Record<string, unknown> | undefined {
	if (platform === "youtube") {
		return {
			title: (opts.title ?? content).slice(0, 100) || "Untitled Video",
			visibility: opts.visibility ?? "public",
		};
	}
	if (platform === "tiktok") {
		return { privacyLevel: opts.privacyLevel ?? "PUBLIC_TO_EVERYONE" };
	}
	return undefined;
}

async function publishVideo(
	ctx: AuthContext,
	ecosystemId: string,
	videoUrl: string,
	content: string,
	opts: VideoOpts,
	accountIds: string[] | undefined,
	platforms: string[] | undefined,
	scheduledFor: string | undefined,
	timezone: string | undefined,
) {
	const profile = await requireProfile(ctx, ecosystemId);
	const { targets, problems } = await resolveVideoTargets(
		ecosystemId,
		accountIds,
		platforms,
	);
	if (targets.length === 0) {
		throw new Error(
			`No video-capable accounts to post to. ${problems.join("; ")}`.trim(),
		);
	}

	const mediaItems = await collectMedia([videoUrl], []);
	if (!mediaItems.some((m) => m.type === "video")) {
		throw new Error("That link doesn't look like a video file.");
	}

	const payloadPlatforms = targets.map((t) => ({
		platform: t.platform,
		accountId: t.accountId,
		platformSpecificData: videoPlatformData(t.platform, content, opts),
	}));

	const postId = await doPost(
		ctx,
		ecosystemId,
		content,
		payloadPlatforms,
		mediaItems,
		scheduledFor,
		timezone,
	);

	return ok({
		status: scheduledFor ? "scheduled" : "published",
		ecosystem: profile.name,
		postedTo: targets.map((t) => ({ platform: t.platform, handle: t.handle })),
		skipped: problems,
		title: opts.title ?? null,
		scheduledFor: scheduledFor ?? null,
		postId,
	});
}

async function publishPost(
	ctx: AuthContext,
	ecosystemId: string,
	accountIds: string[],
	content: string,
	scheduledFor: string | undefined,
	timezone: string | undefined,
	mediaUrls: string[],
	mediaBase64: string[],
	layout: "carousel" | "separate" = "carousel",
) {
	const profile = await requireProfile(ctx, ecosystemId);
	const hasMedia = mediaUrls.length > 0 || mediaBase64.length > 0;
	const { targets, problems } = await resolveTargets(
		ecosystemId,
		accountIds,
		hasMedia,
	);
	if (targets.length === 0) {
		throw new Error(`No valid targets. ${problems.join("; ")}`);
	}

	const mediaItems = await collectMedia(mediaUrls, mediaBase64);
	const payloadPlatforms: PayloadPlatform[] = targets.map((t) => ({
		platform: t.platform,
		accountId: t.accountId,
	}));
	const isScheduled = !!scheduledFor;

	// "separate" → one post per media item; otherwise one post (carousel).
	const batches =
		layout === "separate" && mediaItems.length > 1
			? mediaItems.map((m) => [m])
			: [mediaItems];

	const postIds: string[] = [];
	for (const batch of batches) {
		const id = await doPost(
			ctx,
			ecosystemId,
			content,
			payloadPlatforms,
			batch,
			scheduledFor,
			timezone,
		);
		if (id) postIds.push(id);
	}

	return ok({
		status: isScheduled ? "scheduled" : "published",
		ecosystem: profile.name,
		postedTo: targets.map((t) => ({ platform: t.platform, handle: t.handle })),
		posts: batches.length,
		mediaCount: mediaItems.length,
		layout: mediaItems.length > 1 ? layout : undefined,
		skipped: problems,
		scheduledFor: scheduledFor ?? null,
		postIds,
	});
}

async function listScheduled(ctx: AuthContext, ecosystemId?: string) {
	const profiles = await accessibleProfiles(ctx);
	let ids = profiles.map((p) => p.id);
	if (ecosystemId) ids = ids.filter((id) => id === ecosystemId);
	if (ids.length === 0) return ok({ scheduled: [] });
	const nameById = new Map(profiles.map((p) => [p.id, p.name]));
	const rows = await db
		.select()
		.from(postsLog)
		.where(
			and(inArray(postsLog.profileId, ids), eq(postsLog.status, "scheduled")),
		)
		.orderBy(postsLog.scheduledFor);
	return ok({
		scheduled: rows.map((r) => ({
			id: r.id,
			ecosystem: nameById.get(r.profileId),
			content: r.content,
			scheduledFor: r.scheduledFor,
			platforms: (r.platforms ?? []).map((p) => p.platform),
		})),
	});
}

async function cancelScheduled(ctx: AuthContext, postLogId: string) {
	const post = await db.query.postsLog.findFirst({
		where: eq(postsLog.id, postLogId),
	});
	if (!post) throw new Error("Post not found");
	await requireProfile(ctx, post.profileId);
	if (post.status !== "scheduled")
		throw new Error("Only scheduled posts can be cancelled");
	if (post.postpeerPostId) await postpeer.cancelScheduled(post.postpeerPostId);
	await db
		.update(postsLog)
		.set({ status: "cancelled" })
		.where(eq(postsLog.id, postLogId));
	return ok({ cancelled: true, id: postLogId });
}

async function getAnalytics(ctx: AuthContext, ecosystemId?: string) {
	const profiles = await accessibleProfiles(ctx);
	let ids = profiles.map((p) => p.id);
	if (ecosystemId) ids = ids.filter((id) => id === ecosystemId);
	if (ids.length === 0) return ok({ posts: [] });
	const nameById = new Map(profiles.map((p) => [p.id, p.name]));
	const rows = await db
		.select()
		.from(analyticsSnapshots)
		.where(inArray(analyticsSnapshots.profileId, ids))
		.orderBy(desc(analyticsSnapshots.publishedAt))
		.limit(50);
	return ok({
		posts: rows.map((r) => ({
			ecosystem: nameById.get(r.profileId),
			content: r.content,
			publishedAt: r.publishedAt,
			metrics: r.aggregated,
		})),
	});
}

// ── Server factory ───────────────────────────────────────────────────────────

export function createMcpServer(): McpServer {
	const server = new McpServer({ name: "peerpost", version: "1.0.0" });

	const reg = (
		name: string,
		description: string,
		shape: z.ZodRawShape,
		handler: (
			ctx: AuthContext,
			args: Record<string, unknown>,
		) => Promise<string>,
	) => {
		server.tool(name, description, shape, async (args) => {
			try {
				const text = await handler(getAuth(), args as Record<string, unknown>);
				return { content: [{ type: "text" as const, text }] };
			} catch (e) {
				const message = e instanceof Error ? e.message : "Unknown error";
				return {
					content: [
						{ type: "text" as const, text: JSON.stringify({ error: message }) },
					],
					isError: true,
				};
			}
		});
	};

	reg(
		"list_ecosystems",
		"List ecosystems you can publish to, each with its connected accounts (accountId + platform + handle). A platform can have MANY accounts (e.g. several LinkedIn pages) — each is targeted separately by accountId.",
		{},
		(ctx) => listEcosystems(ctx),
	);

	reg(
		"list_connected_accounts",
		"List the connected social accounts for one ecosystem, with their accountId, platform, and handle. Use the accountId(s) to target specific accounts when posting.",
		{ ecosystemId: z.string().describe("Ecosystem id from list_ecosystems") },
		(ctx, a) => listAccounts(ctx, a.ecosystemId as string),
	);

	const mediaUrlsField = z
		.array(z.string())
		.optional()
		.describe(
			"Optional image/video URLs to attach. Accepts any public image URL, a Google Drive FILE link, or a Google Drive FOLDER link (expands to every image/video inside it). The server fetches and uploads them. Image platforms: twitter, linkedin, facebook, bluesky, threads, instagram.",
		);
	const mediaBase64Field = z
		.array(z.string())
		.optional()
		.describe(
			"Optional images/videos passed as base64 (raw or a data URI like 'data:image/png;base64,…'). USE THIS for an image you GENERATED that has no public URL (e.g. a ChatGPT image saved at /mnt/data/...): read the file, base64-encode it, and pass it here. Keep each item reasonably small.",
		);
	const layoutField = z
		.enum(["carousel", "separate"])
		.optional()
		.describe(
			"With multiple images: 'carousel' = one post containing all of them (default); 'separate' = one post per image. Ask the user which they want when there are several images.",
		);

	reg(
		"preview_post",
		"Validate a post before publishing. Pass the SPECIFIC accountIds to post to (from list_connected_accounts) — never assume a platform maps to one account. Optionally include mediaUrls (image/video URLs or Google Drive links). Checks platform support and character limits. Always preview and get user confirmation before publishing.",
		{
			ecosystemId: z.string(),
			accountIds: z
				.array(z.string())
				.describe("Specific account ids from list_connected_accounts"),
			content: z.string(),
			mediaUrls: mediaUrlsField,
			mediaBase64: mediaBase64Field,
		},
		(ctx, a) =>
			previewPost(
				ctx,
				a.ecosystemId as string,
				a.accountIds as string[],
				a.content as string,
				(a.mediaUrls as string[] | undefined) ?? [],
				(a.mediaBase64 as string[] | undefined) ?? [],
			),
	);

	reg(
		"publish_post",
		"Publish a post now to specific connected accounts (by accountId). Only call after the user confirms the exact accounts. For an image/video: pass mediaUrls (public URLs or Google Drive links), OR — for an image you GENERATED with no public URL — base64-encode it and pass mediaBase64. Text platforms: twitter, linkedin, facebook, bluesky, threads. With media also: instagram.",
		{
			ecosystemId: z.string(),
			accountIds: z
				.array(z.string())
				.describe("Specific account ids from list_connected_accounts"),
			content: z.string(),
			mediaUrls: mediaUrlsField,
			mediaBase64: mediaBase64Field,
			layout: layoutField,
		},
		(ctx, a) =>
			publishPost(
				ctx,
				a.ecosystemId as string,
				a.accountIds as string[],
				a.content as string,
				undefined,
				undefined,
				(a.mediaUrls as string[] | undefined) ?? [],
				(a.mediaBase64 as string[] | undefined) ?? [],
				(a.layout as "carousel" | "separate" | undefined) ?? "carousel",
			),
	);

	reg(
		"schedule_post",
		"Schedule a post to specific connected accounts (by accountId) for a future time (ISO 8601). Optionally include mediaUrls (image/video URLs or Google Drive links). Only call after the user confirms.",
		{
			ecosystemId: z.string(),
			accountIds: z
				.array(z.string())
				.describe("Specific account ids from list_connected_accounts"),
			content: z.string(),
			scheduledFor: z
				.string()
				.describe("ISO 8601 datetime, e.g. 2026-06-20T14:30:00Z"),
			timezone: z.string().optional().describe("IANA tz, default UTC"),
			mediaUrls: mediaUrlsField,
			mediaBase64: mediaBase64Field,
			layout: layoutField,
		},
		(ctx, a) =>
			publishPost(
				ctx,
				a.ecosystemId as string,
				a.accountIds as string[],
				a.content as string,
				a.scheduledFor as string,
				a.timezone as string | undefined,
				(a.mediaUrls as string[] | undefined) ?? [],
				(a.mediaBase64 as string[] | undefined) ?? [],
				(a.layout as "carousel" | "separate" | undefined) ?? "carousel",
			),
	);

	reg(
		"publish_video",
		"Publish a VIDEO (given by URL or Google Drive link) with a caption and optional title. By DEFAULT posts to ALL connected video-capable accounts in the ecosystem (youtube, tiktok, instagram, twitter, facebook, linkedin, bluesky, threads) — narrow with `platforms` or `accountIds`. `title` is the YouTube title (defaults to the caption). Always confirm the target accounts with the user first. Set `scheduledFor` (ISO 8601) to schedule instead of publishing now.",
		{
			ecosystemId: z.string(),
			videoUrl: z
				.string()
				.describe("Public URL or Google Drive link to the video file"),
			content: z.string().describe("Caption / description for the post"),
			title: z
				.string()
				.optional()
				.describe("YouTube title (≤100 chars; defaults to the caption)"),
			platforms: z
				.array(z.string())
				.optional()
				.describe(
					"Limit to these platforms (e.g. ['youtube','tiktok']); omit to post to all video-capable accounts",
				),
			accountIds: z
				.array(z.string())
				.optional()
				.describe("Limit to specific account ids from list_connected_accounts"),
			visibility: z
				.enum(["public", "unlisted", "private"])
				.optional()
				.describe("YouTube visibility (default public)"),
			privacyLevel: z
				.enum([
					"PUBLIC_TO_EVERYONE",
					"MUTUAL_FOLLOW_FRIENDS",
					"FOLLOWER_OF_CREATOR",
					"SELF_ONLY",
				])
				.optional()
				.describe("TikTok privacy (default PUBLIC_TO_EVERYONE)"),
			scheduledFor: z
				.string()
				.optional()
				.describe("ISO 8601 datetime to schedule; omit to publish now"),
			timezone: z.string().optional().describe("IANA tz, default UTC"),
		},
		(ctx, a) =>
			publishVideo(
				ctx,
				a.ecosystemId as string,
				a.videoUrl as string,
				a.content as string,
				{
					title: a.title as string | undefined,
					visibility: a.visibility as string | undefined,
					privacyLevel: a.privacyLevel as string | undefined,
				},
				a.accountIds as string[] | undefined,
				a.platforms as string[] | undefined,
				a.scheduledFor as string | undefined,
				a.timezone as string | undefined,
			),
	);

	reg(
		"list_scheduled",
		"List upcoming scheduled posts (optionally for one ecosystem).",
		{ ecosystemId: z.string().optional() },
		(ctx, a) => listScheduled(ctx, a.ecosystemId as string | undefined),
	);

	reg(
		"cancel_scheduled",
		"Cancel a scheduled post by its id (from list_scheduled).",
		{ postId: z.string() },
		(ctx, a) => cancelScheduled(ctx, a.postId as string),
	);

	reg(
		"get_analytics",
		"Recent post analytics (impressions, likes, views, engagement) for accessible ecosystems.",
		{ ecosystemId: z.string().optional() },
		(ctx, a) => getAnalytics(ctx, a.ecosystemId as string | undefined),
	);

	return server;
}
