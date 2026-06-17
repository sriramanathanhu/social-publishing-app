import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { platformEnum, postsLog, providerProfiles } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getProvider, type ProviderName } from "@/lib/providers";
import type {
	ProviderMediaItem,
	ProviderPlatformTarget,
} from "@/lib/providers/types";
import { assertAccountInProfile, assertProfileAccess } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/** GET — audit log of posts for this profile. */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const posts = await db
		.select()
		.from(postsLog)
		.where(eq(postsLog.profileId, id))
		.orderBy(postsLog.createdAt);

	return Response.json({ posts });
});

const mediaSchema = z.object({
	type: z.enum(["image", "video", "gif"]),
	url: z.string().url(),
	thumbnail: z.string().url().optional(),
});

const publishSchema = z
	.object({
		content: z.string().min(1),
		platforms: z
			.array(
				z.object({
					platform: z.enum(platformEnum.enumValues),
					accountId: z.string().min(1),
					content: z.string().optional(),
					platformSpecificData: z.record(z.unknown()).optional(),
				}),
			)
			.min(1),
		mediaItems: z.array(mediaSchema).optional(),
		publishNow: z.boolean().optional(),
		scheduledFor: z.string().datetime().optional(),
		timezone: z.string().optional(),
	})
	.refine((d) => d.publishNow || d.scheduledFor, {
		message: "Provide publishNow:true or scheduledFor",
	});

type Target = z.infer<typeof publishSchema>["platforms"][number];
type PlatformResult = {
	platform: string;
	success: boolean;
	error?: string;
	url?: string;
};

/**
 * POST /api/profiles/:id/posts  (req #6 — schedule/publish)
 *
 * Editor+ on the profile. Every target accountId is re-validated against
 * integrations_cache for THIS profile (a client can never publish to an account
 * it doesn't own), which also tells us each account's PROVIDER. Targets are
 * grouped by provider and dispatched to the matching client (PostPeer / Zernio);
 * each provider call is logged as its own posts_log row, and the per-platform
 * results are merged for the response.
 */
export const POST = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const input = publishSchema.parse(await request.json());
	const isScheduled = !input.publishNow && !!input.scheduledFor;

	// Authorize each target and learn its provider from integrations_cache.
	const integrations = await Promise.all(
		input.platforms.map((p) => assertAccountInProfile(user, id, p.accountId)),
	);
	const providerByAccount = new Map<string, ProviderName>();
	input.platforms.forEach((p, i) => {
		providerByAccount.set(p.accountId, integrations[i].provider);
	});

	// Group targets by provider.
	const groups = new Map<ProviderName, Target[]>();
	for (const p of input.platforms) {
		const provider = providerByAccount.get(p.accountId) as ProviderName;
		const list = groups.get(provider) ?? [];
		list.push(p);
		groups.set(provider, list);
	}

	// Resolve external profile ids (Zernio needs the profile id in the body).
	const mappings = await db
		.select()
		.from(providerProfiles)
		.where(eq(providerProfiles.profileId, id));
	const externalProfileId = (provider: ProviderName): string | undefined =>
		mappings.find((m) => m.provider === provider)?.externalProfileId;

	const mediaItems = input.mediaItems as ProviderMediaItem[] | undefined;
	const allResults: PlatformResult[] = [];
	const failures: string[] = [];

	// Dispatch each provider group, logging one posts_log row per group.
	for (const [provider, targets] of groups) {
		const [logRow] = await db
			.insert(postsLog)
			.values({
				profileId: id,
				authorUserId: user.id,
				provider,
				status: isScheduled ? "scheduled" : "publishing",
				content: input.content,
				platforms: targets.map((p) => ({
					platform: p.platform,
					accountId: p.accountId,
					content: p.content,
				})),
				scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
				timezone: input.timezone ?? null,
			})
			.returning();

		try {
			const result = await getProvider(provider).createPost({
				content: input.content,
				platforms: targets as ProviderPlatformTarget[],
				mediaItems,
				publishNow: input.publishNow,
				scheduledFor: input.scheduledFor,
				timezone: input.timezone,
				profileExternalId: externalProfileId(provider),
			});
			allResults.push(...result.platforms);

			if (!result.success) {
				const detail =
					result.platforms
						.filter((p) => !p.success)
						.map((p) => `${p.platform}: ${p.error ?? "failed"}`)
						.join("; ") ||
					result.message ||
					`${provider}: publishing failed`;
				failures.push(detail);
				await db
					.update(postsLog)
					.set({
						status: "failed",
						postpeerPostId: result.postId,
						error: detail,
					})
					.where(eq(postsLog.id, logRow.id));
			} else {
				await db
					.update(postsLog)
					.set({
						postpeerPostId: result.postId,
						status: isScheduled ? "scheduled" : "published",
					})
					.where(eq(postsLog.id, logRow.id));
			}
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			failures.push(`${provider}: ${msg}`);
			for (const t of targets)
				allResults.push({ platform: t.platform, success: false, error: msg });
			await db
				.update(postsLog)
				.set({ status: "failed", error: msg })
				.where(eq(postsLog.id, logRow.id));
		}
	}

	if (failures.length > 0) {
		return Response.json(
			{ error: failures.join("; "), platforms: allResults },
			{ status: 400 },
		);
	}

	return Response.json({ ok: true, platforms: allResults }, { status: 201 });
});
