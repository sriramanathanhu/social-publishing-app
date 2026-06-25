import "server-only";
import { and, eq, inArray, isNotNull, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
	dubAutopublishRules,
	dubJobs,
	integrationsCache,
	postsLog,
	providerProfiles,
	users,
} from "@/db/schema";
import type { AppUser } from "@/lib/auth";
import { dubPrefill } from "@/lib/dub-prefill";
import { getProvider, type ProviderName } from "@/lib/providers";
import type {
	ProviderMediaItem,
	ProviderPlatformTarget,
} from "@/lib/providers/types";
import { getAccessibleProfiles } from "@/lib/queries";
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
 * Auto-publish driver. For every finished dub whose OWNER has the global
 * `dubAutopublish` toggle on (and isn't published yet), route it to the accounts
 * mapped for its language in any of the owner's accessible ecosystems. No
 * per-dub opt-in. Idempotent: claims each job (sets auto_published_at) before
 * posting; releases the claim if nothing was scheduled so it retries. Returns
 * the number of dubs auto-scheduled.
 */
export async function runDubAutopublish(): Promise<number> {
	const due = await db
		.select({ job: dubJobs, owner: users })
		.from(dubJobs)
		.innerJoin(users, eq(users.id, dubJobs.userId))
		.where(
			and(
				eq(dubJobs.status, "done"),
				eq(users.dubAutopublish, true),
				isNull(dubJobs.autoPublishedAt),
				isNotNull(dubJobs.archiveKey),
			),
		)
		.limit(50);

	let count = 0;
	for (const { job, owner } of due) {
		// Claim it (prevents a concurrent run from double-posting).
		const [claimed] = await db
			.update(dubJobs)
			.set({ autoPublishedAt: new Date() })
			.where(and(eq(dubJobs.id, job.id), isNull(dubJobs.autoPublishedAt)))
			.returning();
		if (!claimed) continue;

		const release = () =>
			db
				.update(dubJobs)
				.set({ autoPublishedAt: null })
				.where(eq(dubJobs.id, job.id));

		try {
			const url = r2PublicUrl(job.archiveKey);
			if (!url) {
				await release();
				continue;
			}
			// Rules for this language in any ecosystem the owner can publish to.
			const accessibleIds = (await getAccessibleProfiles(owner as AppUser)).map(
				(p) => p.id,
			);
			if (accessibleIds.length === 0) continue; // nothing to route to
			const rules = await db
				.select()
				.from(dubAutopublishRules)
				.where(
					and(
						eq(dubAutopublishRules.lang, job.targetLang),
						inArray(dubAutopublishRules.profileId, accessibleIds),
					),
				);
			if (rules.length === 0) continue; // no rule for this language — done

			const { caption } = dubPrefill(job.captions);
			const content = caption || `Dubbed → ${job.targetLang}`;
			let scheduled = 0;
			for (const rule of rules) {
				if (rule.accountIds.length === 0) continue;
				const when = new Date(
					Date.now() + rule.bufferMinutes * 60_000,
				).toISOString();
				scheduled += await scheduleVideoToAccounts(
					rule.profileId,
					job.userId,
					content,
					url,
					rule.accountIds,
					when,
				);
			}
			if (scheduled > 0) count++;
			else await release(); // couldn't schedule any — retry next run
		} catch {
			await release();
		}
	}
	return count;
}
