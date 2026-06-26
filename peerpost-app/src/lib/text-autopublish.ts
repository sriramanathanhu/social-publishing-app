import "server-only";
import { and, eq, gt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	articles,
	integrationsCache,
	postsLog,
	providerProfiles,
	textAutopublishRules,
	transcriptJobs,
} from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import type { AppUser } from "@/lib/auth";
import { getProvider, type ProviderName } from "@/lib/providers";
import type { ProviderPlatformTarget } from "@/lib/providers/types";
import { getAccessibleProfiles } from "@/lib/queries";
import { translateText } from "@/lib/translate-text";

export type TextKind = "article" | "transcript";

/** Schedule a text post (no media) to a set of accounts under a profile. Reddit
 * needs a post title, passed via platformSpecificData (harmless elsewhere).
 * Returns # scheduled ok. */
async function scheduleTextToAccounts(
	profileId: string,
	userId: string,
	content: string,
	title: string,
	accountIds: string[],
	scheduledFor: string,
	source: string,
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
				source,
				content,
				platforms: [{ platform: a.platform, accountId: a.postpeerAccountId }],
				scheduledFor: new Date(scheduledFor),
			})
			.returning();
		try {
			const target: ProviderPlatformTarget = {
				platform: a.platform,
				accountId: a.postpeerAccountId,
				platformSpecificData:
					a.platform === "reddit" && title ? { title } : undefined,
			};
			const result = await getProvider(provider).createPost({
				content,
				platforms: [target],
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

/** Next schedule slot for a set of accounts: never before now+buffer, never
 * closer than gap after the latest pending auto-post of this source to them. */
async function dripSlot(
	accountIds: string[],
	bufferMinutes: number,
	gapMinutes: number,
	source: string,
): Promise<string> {
	const nowMs = Date.now();
	const earliest = nowMs + bufferMinutes * 60_000;
	if (gapMinutes <= 0) return new Date(earliest).toISOString();
	const [row] = await db
		.select({ last: sql<string | null>`max(${postsLog.scheduledFor})` })
		.from(postsLog)
		.where(
			and(
				eq(postsLog.source, source),
				eq(postsLog.status, "scheduled"),
				gt(postsLog.scheduledFor, new Date(nowMs)),
				inArray(sql`(${postsLog.platforms} -> 0 ->> 'accountId')`, accountIds),
			),
		);
	const lastMs = row?.last ? new Date(row.last).getTime() : 0;
	const whenMs =
		lastMs > 0 ? Math.max(earliest, lastMs + gapMinutes * 60_000) : earliest;
	return new Date(whenMs).toISOString();
}

/** Load the source piece's text + title + its own language. */
async function loadItem(
	user: AppUser,
	kind: TextKind,
	itemId: string,
): Promise<{ text: string; title: string; lang: string } | null> {
	if (kind === "article") {
		const a = await db.query.articles.findFirst({
			where: and(eq(articles.id, itemId), eq(articles.userId, user.id)),
		});
		if (!a || !a.content.trim()) return null;
		return {
			text: a.content,
			title: a.title ?? a.topic,
			lang: a.outputLang ?? "English",
		};
	}
	const t = await db.query.transcriptJobs.findFirst({
		where: and(
			eq(transcriptJobs.id, itemId),
			eq(transcriptJobs.userId, user.id),
		),
	});
	if (!t || !t.transcript?.trim()) return null;
	return {
		text: t.transcript,
		title: t.title,
		lang: t.outputLang ?? "English",
	};
}

/**
 * Translate one generated piece into each chosen language and broadcast the
 * translated text to that language's mapped accounts (per the kind's rules).
 * The source language is posted as-is (no translation). One auth check.
 */
export async function autoScheduleText(
	user: AppUser,
	input: { kind: TextKind; itemId: string; languages: string[] },
): Promise<{
	languages: number;
	scheduled: number;
	failed: number;
	error?: string;
}> {
	const empty = { languages: 0, scheduled: 0, failed: 0 };

	const item = await loadItem(user, input.kind, input.itemId);
	if (!item) return { ...empty, error: "Content not found or empty." };

	const profileIds = (await getAccessibleProfiles(user)).map((p) => p.id);
	if (profileIds.length === 0)
		return { ...empty, error: "No ecosystems you can publish to." };

	// Rules for this kind in accessible ecosystems → lang → [{profileId, accounts}].
	const rules = await db
		.select()
		.from(textAutopublishRules)
		.where(
			and(
				eq(textAutopublishRules.kind, input.kind),
				inArray(textAutopublishRules.profileId, profileIds),
			),
		);
	const byLang = new Map<string, (typeof rules)[number][]>();
	for (const r of rules) {
		if (!r.accountIds.length) continue;
		const arr = byLang.get(r.lang) ?? [];
		arr.push(r);
		byLang.set(r.lang, arr);
	}

	const targets = input.languages.filter((l) => byLang.has(l));
	if (targets.length === 0)
		return { ...empty, error: "None of the chosen languages have a rule." };

	const source = `${input.kind}-auto`;
	const keys = await getUserKeys(user.id);

	let scheduled = 0;
	let failed = 0;
	let usedLangs = 0;
	for (const lang of targets) {
		// Translate once per language (skip if it's already the source language).
		let content = item.text;
		if (lang.toLowerCase() !== item.lang.toLowerCase()) {
			if (!keys.gemini) {
				failed++;
				continue;
			}
			try {
				content = await translateText(item.text, lang, keys.gemini);
			} catch {
				failed++;
				continue;
			}
		}
		usedLangs++;
		for (const rule of byLang.get(lang) ?? []) {
			const when = await dripSlot(
				rule.accountIds,
				rule.bufferMinutes,
				rule.gapMinutes,
				source,
			);
			const n = await scheduleTextToAccounts(
				rule.profileId,
				user.id,
				content,
				item.title,
				rule.accountIds,
				when,
				source,
			);
			scheduled += n;
			if (n === 0) failed++;
		}
	}

	return { languages: usedLangs, scheduled, failed };
}
