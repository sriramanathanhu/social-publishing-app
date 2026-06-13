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
import { postpeer } from "./postpeer";

const { analyticsSnapshots, integrationsCache, postsLog } = schema;

// v1 is text-only: these platforms require media and are not yet supported.
const TEXT_CAPABLE = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"bluesky",
	"threads",
]);
const CHAR_LIMIT: Record<string, number> = { twitter: 280, bluesky: 300 };

async function connectedAccounts(profileId: string) {
	return db
		.select({
			platform: integrationsCache.platform,
			accountId: integrationsCache.postpeerAccountId,
			handle: integrationsCache.handle,
		})
		.from(integrationsCache)
		.where(eq(integrationsCache.profileId, profileId));
}

/** Validate a set of target platforms against connections + text-only rules. */
async function resolveTargets(profileId: string, platforms: string[]) {
	const accounts = await connectedAccounts(profileId);
	const byPlatform = new Map(accounts.map((a) => [a.platform, a]));
	const targets: { platform: string; accountId: string }[] = [];
	const problems: string[] = [];
	for (const p of platforms) {
		if (!TEXT_CAPABLE.has(p)) {
			problems.push(`${p}: not supported in text-only mode (needs media)`);
			continue;
		}
		const a = byPlatform.get(p);
		if (!a) {
			problems.push(`${p}: not connected on this ecosystem`);
			continue;
		}
		targets.push({ platform: p, accountId: a.accountId });
	}
	return { targets, problems };
}

function checkContent(content: string, platforms: string[]): string[] {
	const warns: string[] = [];
	for (const p of platforms) {
		const lim = CHAR_LIMIT[p];
		if (lim && content.length > lim)
			warns.push(`${p}: content is ${content.length} chars (limit ${lim})`);
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
				connected: accts.map((a) => ({
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
			platform: a.platform,
			handle: a.handle,
			textCapable: TEXT_CAPABLE.has(a.platform),
		})),
	});
}

async function previewPost(
	ctx: AuthContext,
	ecosystemId: string,
	platforms: string[],
	content: string,
) {
	const profile = await requireProfile(ctx, ecosystemId);
	const { targets, problems } = await resolveTargets(ecosystemId, platforms);
	const warnings = [...problems, ...checkContent(content, platforms)];
	return ok({
		ecosystem: profile.name,
		willPostTo: targets.map((t) => t.platform),
		content,
		warnings,
		ready: targets.length > 0,
	});
}

async function publishPost(
	ctx: AuthContext,
	ecosystemId: string,
	platforms: string[],
	content: string,
	scheduledFor: string | undefined,
	timezone: string | undefined,
) {
	const profile = await requireProfile(ctx, ecosystemId);
	const { targets, problems } = await resolveTargets(ecosystemId, platforms);
	if (targets.length === 0) {
		throw new Error(`No valid targets. ${problems.join("; ")}`);
	}
	const isScheduled = !!scheduledFor;

	const [logRow] = await db
		.insert(postsLog)
		.values({
			profileId: ecosystemId,
			authorUserId: ctx.userId,
			status: isScheduled ? "scheduled" : "publishing",
			content,
			platforms: targets,
			scheduledFor: scheduledFor ? new Date(scheduledFor) : null,
			timezone: timezone ?? null,
		})
		.returning();

	try {
		const result = await postpeer.createPost({
			content,
			platforms: targets,
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

		return ok({
			status: isScheduled ? "scheduled" : "published",
			ecosystem: profile.name,
			platforms: targets.map((t) => t.platform),
			skipped: problems,
			scheduledFor: scheduledFor ?? null,
			postId: postpeerPostId,
		});
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
		"List ecosystems you can publish to, with their connected platforms.",
		{},
		(ctx) => listEcosystems(ctx),
	);

	reg(
		"list_connected_accounts",
		"List the connected social accounts for one ecosystem.",
		{ ecosystemId: z.string().describe("Ecosystem id from list_ecosystems") },
		(ctx, a) => listAccounts(ctx, a.ecosystemId as string),
	);

	reg(
		"preview_post",
		"Validate a post before publishing: checks platform connections, text-only support, and character limits. Always preview and get user confirmation before publishing.",
		{
			ecosystemId: z.string(),
			platforms: z.array(z.string()).describe("e.g. ['twitter','linkedin']"),
			content: z.string(),
		},
		(ctx, a) =>
			previewPost(
				ctx,
				a.ecosystemId as string,
				a.platforms as string[],
				a.content as string,
			),
	);

	reg(
		"publish_post",
		"Publish a text post now to the chosen ecosystem + platforms. Only call after the user confirms. Text-only: twitter, linkedin, facebook, bluesky, threads.",
		{
			ecosystemId: z.string(),
			platforms: z.array(z.string()),
			content: z.string(),
		},
		(ctx, a) =>
			publishPost(
				ctx,
				a.ecosystemId as string,
				a.platforms as string[],
				a.content as string,
				undefined,
				undefined,
			),
	);

	reg(
		"schedule_post",
		"Schedule a text post for a future time (ISO 8601). Only call after the user confirms.",
		{
			ecosystemId: z.string(),
			platforms: z.array(z.string()),
			content: z.string(),
			scheduledFor: z
				.string()
				.describe("ISO 8601 datetime, e.g. 2026-06-20T14:30:00Z"),
			timezone: z.string().optional().describe("IANA tz, default UTC"),
		},
		(ctx, a) =>
			publishPost(
				ctx,
				a.ecosystemId as string,
				a.platforms as string[],
				a.content as string,
				a.scheduledFor as string,
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
