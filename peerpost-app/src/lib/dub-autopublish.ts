import "server-only";
import { and, eq, gt, inArray, isNotNull, isNull, sql } from "drizzle-orm";
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

type Rule = typeof dubAutopublishRules.$inferSelect;

/**
 * Compute when to schedule this dub for a rule, applying the drip stagger.
 * - Base = now + bufferMinutes (the head start before the first post).
 * - If gapMinutes > 0, never land closer than gapMinutes after the latest
 *   already-scheduled auto-post to these same accounts — so a batch finishing
 *   minutes apart still goes out spaced `gapMinutes` apart instead of flooding.
 */
async function nextDripSlot(rule: Rule): Promise<string> {
	const nowMs = Date.now();
	const earliestMs = nowMs + rule.bufferMinutes * 60_000;
	if (rule.gapMinutes <= 0) return new Date(earliestMs).toISOString();

	// Latest still-pending auto-post aimed at any of this rule's accounts. Each
	// dub-auto row carries exactly one account at platforms[0].accountId.
	const [row] = await db
		.select({ last: sql<string | null>`max(${postsLog.scheduledFor})` })
		.from(postsLog)
		.where(
			and(
				eq(postsLog.source, "dub-auto"),
				eq(postsLog.status, "scheduled"),
				gt(postsLog.scheduledFor, new Date(nowMs)),
				inArray(
					sql`(${postsLog.platforms} -> 0 ->> 'accountId')`,
					rule.accountIds,
				),
			),
		);
	const lastMs = row?.last ? new Date(row.last).getTime() : 0;
	const whenMs =
		lastMs > 0
			? Math.max(earliestMs, lastMs + rule.gapMinutes * 60_000)
			: earliestMs;
	return new Date(whenMs).toISOString();
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

		// The claim is PERMANENT (run-once). We never release it on a posting
		// failure — otherwise a dub whose content PostPeer rejects (e.g. an
		// "already scheduled" duplicate) would be retried every minute, spamming
		// failed posts forever. A failure is recorded in posts_log to retry by hand.
		try {
			const url = r2PublicUrl(job.archiveKey);
			if (!url) continue;
			// Rules for this language in any ecosystem the owner can publish to.
			const accessibleIds = (await getAccessibleProfiles(owner as AppUser)).map(
				(p) => p.id,
			);
			if (accessibleIds.length === 0) continue;
			const rules = await db
				.select()
				.from(dubAutopublishRules)
				.where(
					and(
						eq(dubAutopublishRules.lang, job.targetLang),
						inArray(dubAutopublishRules.profileId, accessibleIds),
					),
				);
			if (rules.length === 0) continue; // no rule for this language

			const { caption } = dubPrefill(job.captions);
			const content = caption || `Dubbed → ${job.targetLang}`;
			let scheduled = 0;
			for (const rule of rules) {
				if (rule.accountIds.length === 0) continue;
				const when = await nextDripSlot(rule);
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
		} catch {
			/* keep the claim — never loop */
		}
	}
	return count;
}
