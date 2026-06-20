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
 * it doesn't own), which also tells us each account's PROVIDER. Each account is
 * then published INDEPENDENTLY through its provider (PostPeer / Zernio) — so a
 * single disconnected / needs-reauth account can't fail the others — and the
 * per-account results are merged for the response (201 unless ALL fail).
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

	// Resolve external profile ids (Zernio needs the profile id in the body).
	const mappings = await db
		.select()
		.from(providerProfiles)
		.where(eq(providerProfiles.profileId, id));
	const externalProfileId = (provider: ProviderName): string | undefined =>
		mappings.find((m) => m.provider === provider)?.externalProfileId;

	const mediaItems = input.mediaItems as ProviderMediaItem[] | undefined;

	// Publish each account INDEPENDENTLY (its own provider call + posts_log row)
	// so a single disconnected / needs-reauth account can't fail the others — the
	// batch call would reject the whole group on one bad account. Run in parallel.
	const settled = await Promise.all(
		input.platforms.map(async (p) => {
			const provider = providerByAccount.get(p.accountId) as ProviderName;
			const [logRow] = await db
				.insert(postsLog)
				.values({
					profileId: id,
					authorUserId: user.id,
					provider,
					status: isScheduled ? "scheduled" : "publishing",
					content: input.content,
					platforms: [
						{
							platform: p.platform,
							accountId: p.accountId,
							content: p.content,
						},
					],
					scheduledFor: input.scheduledFor
						? new Date(input.scheduledFor)
						: null,
					timezone: input.timezone ?? null,
				})
				.returning();

			try {
				const result = await getProvider(provider).createPost({
					content: input.content,
					platforms: [p] as ProviderPlatformTarget[],
					mediaItems,
					publishNow: input.publishNow,
					scheduledFor: input.scheduledFor,
					timezone: input.timezone,
					profileExternalId: externalProfileId(provider),
				});
				const pr: PlatformResult = result.platforms[0] ?? {
					platform: p.platform,
					success: result.success,
					error: result.success ? undefined : (result.message ?? "failed"),
				};
				const ok = result.success && pr.success !== false;
				await db
					.update(postsLog)
					.set(
						ok
							? {
									postpeerPostId: result.postId,
									status: isScheduled ? "scheduled" : "published",
								}
							: {
									status: "failed",
									postpeerPostId: result.postId,
									error: pr.error ?? result.message ?? "failed",
								},
					)
					.where(eq(postsLog.id, logRow.id));
				return {
					pr,
					failure: ok ? null : `${p.platform}: ${pr.error ?? "failed"}`,
				};
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await db
					.update(postsLog)
					.set({ status: "failed", error: msg })
					.where(eq(postsLog.id, logRow.id));
				return {
					pr: { platform: p.platform, success: false, error: msg },
					failure: `${p.platform}: ${msg}`,
				};
			}
		}),
	);

	const allResults: PlatformResult[] = settled.map((s) => s.pr);
	const failures = settled
		.map((s) => s.failure)
		.filter((f): f is string => Boolean(f));

	// Hard error only if EVERY account failed; partial success returns 201 with
	// the per-platform breakdown so the good accounts are clearly published.
	if (!allResults.some((r) => r.success)) {
		return Response.json(
			{
				error: failures.join("; ") || "Publishing failed",
				platforms: allResults,
			},
			{ status: 400 },
		);
	}
	return Response.json(
		{ ok: true, platforms: allResults, errors: failures },
		{ status: 201 },
	);
});
