import "server-only";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	dubAutopublishRules,
	dubJobs,
	integrationsCache,
	postsLog,
	providerProfiles,
} from "@/db/schema";
import { dubPrefill } from "@/lib/dub-prefill";
import { getProvider, type ProviderName } from "@/lib/providers";
import type {
	ProviderMediaItem,
	ProviderPlatformTarget,
} from "@/lib/providers/types";
import { r2PublicUrl } from "@/lib/r2";

/** Schedule one video to a set of accounts under a profile (each provider call
 * is independent; results recorded in posts_log). Returns # scheduled ok. */
async function scheduleVideoToAccounts(
	profileId: string,
	userId: string,
	content: string,
	videoUrl: string,
	accountIds: string[],
	scheduledFor: string,
): Promise<number> {
	const accounts = await db
		.select()
		.from(integrationsCache)
		.where(
			and(
				eq(integrationsCache.profileId, profileId),
				inArray(integrationsCache.postpeerAccountId, accountIds),
				eq(integrationsCache.active, true),
			),
		);
	if (accounts.length === 0) return 0;

	const mappings = await db
		.select()
		.from(providerProfiles)
		.where(eq(providerProfiles.profileId, profileId));
	const externalFor = (provider: ProviderName): string | undefined =>
		mappings.find((m) => m.provider === provider)?.externalProfileId ??
		undefined;

	const mediaItems: ProviderMediaItem[] = [{ type: "video", url: videoUrl }];
	let ok = 0;
	for (const a of accounts) {
		const provider = a.provider as ProviderName;
		const [row] = await db
			.insert(postsLog)
			.values({
				profileId,
				authorUserId: userId,
				provider,
				status: "publishing",
				source: "dub-auto",
				content,
				platforms: [{ platform: a.platform, accountId: a.postpeerAccountId }],
				scheduledFor: new Date(scheduledFor),
			})
			.returning();
		try {
			const target: ProviderPlatformTarget = {
				platform: a.platform,
				accountId: a.postpeerAccountId,
			};
			const result = await getProvider(provider).createPost({
				content,
				platforms: [target],
				mediaItems,
				publishNow: false,
				scheduledFor,
				profileExternalId: a.externalProfileId ?? externalFor(provider),
			});
			const pr = result.platforms[0];
			const good = result.success && pr?.success !== false;
			await db
				.update(postsLog)
				.set(
					good
						? {
								postpeerPostId: result.postId,
								publishedUrl: pr?.url ?? null,
								status: "scheduled",
							}
						: {
								status: "failed",
								error: pr?.error ?? result.message ?? "failed",
							},
				)
				.where(eq(postsLog.id, row.id));
			if (good) ok++;
		} catch (err) {
			await db
				.update(postsLog)
				.set({ status: "failed", error: String(err) })
				.where(eq(postsLog.id, row.id));
		}
	}
	return ok;
}

/**
 * Find finished dubs that opted into auto-publish and route each to its
 * language's saved accounts, scheduled `bufferMinutes` out. Idempotent: claims
 * each job (sets auto_published_at) before posting; resets it if nothing was
 * scheduled so a transient failure retries. Returns # dubs auto-scheduled.
 */
export async function runDubAutopublish(): Promise<number> {
	const due = await db
		.select()
		.from(dubJobs)
		.where(
			and(
				eq(dubJobs.status, "done"),
				isNotNull(dubJobs.autoPublishProfileId),
				isNull(dubJobs.autoPublishedAt),
				isNotNull(dubJobs.archiveKey),
			),
		)
		.limit(50);

	let count = 0;
	for (const job of due) {
		const profileId = job.autoPublishProfileId;
		if (!profileId) continue;
		// Claim it (prevents a concurrent run from double-posting).
		const [claimed] = await db
			.update(dubJobs)
			.set({ autoPublishedAt: new Date() })
			.where(and(eq(dubJobs.id, job.id), isNull(dubJobs.autoPublishedAt)))
			.returning();
		if (!claimed) continue;

		try {
			const rule = await db.query.dubAutopublishRules.findFirst({
				where: and(
					eq(dubAutopublishRules.profileId, profileId),
					eq(dubAutopublishRules.lang, job.targetLang),
				),
			});
			const url = r2PublicUrl(job.archiveKey);
			if (!rule || rule.accountIds.length === 0 || !url) {
				// No route / not hostable yet — release the claim for a later retry
				// only if there's genuinely no rule we'd want to keep it claimed.
				if (!rule || rule.accountIds.length === 0) continue; // nothing to do
				await db
					.update(dubJobs)
					.set({ autoPublishedAt: null })
					.where(eq(dubJobs.id, job.id));
				continue;
			}
			const { caption } = dubPrefill(job.captions);
			const when = new Date(
				Date.now() + rule.bufferMinutes * 60_000,
			).toISOString();
			const ok = await scheduleVideoToAccounts(
				profileId,
				job.userId,
				caption || `Dubbed → ${job.targetLang}`,
				url,
				rule.accountIds,
				when,
			);
			if (ok > 0) count++;
			else {
				// Couldn't schedule any — let it retry next run.
				await db
					.update(dubJobs)
					.set({ autoPublishedAt: null })
					.where(eq(dubJobs.id, job.id));
			}
		} catch {
			await db
				.update(dubJobs)
				.set({ autoPublishedAt: null })
				.where(eq(dubJobs.id, job.id));
		}
	}
	return count;
}
