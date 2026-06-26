import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
	integrationsCache,
	postsLog,
	providerProfiles,
	quoteAutopublishRules,
	quoteBackgrounds,
	quoteItems,
	quoteOverlays,
} from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import type { AppUser } from "@/lib/auth";
import { getProvider, type ProviderName } from "@/lib/providers";
import type {
	ProviderMediaItem,
	ProviderPlatformTarget,
} from "@/lib/providers/types";
import { getAccessibleProfiles } from "@/lib/queries";
import { renderQuoteCard } from "@/lib/quote-card";
import { generateQuotes } from "@/lib/quotes";

/** Schedule one rendered card image to a set of accounts under a profile (each
 * provider call independent; recorded in posts_log). Returns # scheduled ok. */
export async function scheduleImageToAccounts(
	profileId: string,
	userId: string,
	content: string,
	imageUrl: string,
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

	const mediaItems: ProviderMediaItem[] = [{ type: "image", url: imageUrl }];
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
				source: "quote",
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

export type AutoPublishQuotesInput = {
	content: string;
	count: number;
	tone?: string;
	languages?: string[];
};

export type SavedQuote = {
	id: string;
	text: string;
	hashtags: string[];
	bgUrl: string | null;
	overlayUrl: string | null;
	cardUrl: string | null;
	panY: number;
	zoom: number;
	batchId: string | null;
	outputLang: string | null;
};

/**
 * Server-side "Generate & auto-schedule": for each language that has a quote
 * rule, generate quotes, render each into a card (rotating the library
 * backgrounds + the default overlay), and schedule every card to that
 * language's mapped accounts — first one `bufferMinutes` out, then one every
 * `gapMinutes` (drip). Runs under ONE auth check (the route's requireUser),
 * unlike the old client flow whose per-call session re-validation overwhelmed
 * Nandi. Returns a summary plus the saved quotes (with cards) for display.
 */
export async function autoPublishQuotes(
	user: AppUser,
	input: AutoPublishQuotesInput,
): Promise<{
	languages: string[];
	rendered: number;
	scheduled: number;
	failed: number;
	items: SavedQuote[];
	error?: string;
}> {
	const empty = {
		languages: [],
		rendered: 0,
		scheduled: 0,
		failed: 0,
		items: [],
	};

	const profiles = await getAccessibleProfiles(user);
	const profileIds = profiles.map((p) => p.id);
	if (profileIds.length === 0)
		return { ...empty, error: "No ecosystems you can publish to." };

	// Rules across accessible ecosystems → language → routes.
	const rules = await db
		.select()
		.from(quoteAutopublishRules)
		.where(inArray(quoteAutopublishRules.profileId, profileIds));
	const byLang = new Map<string, (typeof rules)[number][]>();
	for (const r of rules) {
		if (!r.accountIds.length) continue;
		const arr = byLang.get(r.lang) ?? [];
		arr.push(r);
		byLang.set(r.lang, arr);
	}
	if (byLang.size === 0)
		return {
			...empty,
			error:
				"No quote auto-publish rules yet — map a language to accounts first.",
		};

	const targetLangs = (
		input.languages?.length ? input.languages : [...byLang.keys()]
	).filter((l) => byLang.has(l));
	if (targetLangs.length === 0)
		return { ...empty, error: "None of the chosen languages have a rule." };

	// Card style: rotate the (shared) library backgrounds + the default overlay.
	const bgRows = await db
		.select({ url: quoteBackgrounds.url })
		.from(quoteBackgrounds)
		.orderBy(desc(quoteBackgrounds.createdAt));
	const bgPool = bgRows.map((b) => b.url).filter(Boolean);
	if (bgPool.length === 0)
		return {
			...empty,
			error: "Add at least one Quote background to the library first.",
		};
	const [overlay] = await db
		.select({ url: quoteOverlays.url })
		.from(quoteOverlays)
		.orderBy(desc(quoteOverlays.isDefault), desc(quoteOverlays.createdAt))
		.limit(1);
	const overlayUrl = overlay?.url;

	const keys = await getUserKeys(user.id);

	let rendered = 0;
	let scheduled = 0;
	let failed = 0;
	const items: SavedQuote[] = [];

	for (let li = 0; li < targetLangs.length; li++) {
		const lang = targetLangs[li];
		let gen: Awaited<ReturnType<typeof generateQuotes>>;
		try {
			gen = await generateQuotes(input.content, {
				geminiKey: keys.gemini,
				nvidiaKey: keys.nvidia,
				count: input.count,
				tone: input.tone,
				outputLang: lang,
			});
		} catch {
			failed++;
			continue;
		}
		if (gen.quotes.length === 0) continue;

		const batchId = randomUUID();
		const saved = await db
			.insert(quoteItems)
			.values(
				gen.quotes.map((q) => ({
					userId: user.id,
					text: q.text,
					hashtags: q.hashtags,
					batchId,
					outputLang: lang,
				})),
			)
			.returning();

		const routes = byLang.get(lang) ?? [];
		for (let i = 0; i < saved.length; i++) {
			const q = saved[i];
			const bg = bgPool[(li * 3 + i) % bgPool.length];
			let cardUrl: string | null = null;
			try {
				const res = await renderQuoteCard({
					photoUrl: bg,
					quote: q.text,
					overlayUrl,
					finalize: true,
				});
				if (res.ok) cardUrl = (await res.json()).publicUrl ?? null;
			} catch {
				/* render failed */
			}
			if (!cardUrl) {
				failed++;
				items.push(toSaved(q, bg, overlayUrl ?? null, null));
				continue;
			}
			rendered++;
			await db
				.update(quoteItems)
				.set({ cardUrl, bgUrl: bg, overlayUrl: overlayUrl ?? null })
				.where(eq(quoteItems.id, q.id));
			items.push(toSaved(q, bg, overlayUrl ?? null, cardUrl));

			const tags = q.hashtags ?? [];
			const caption = tags.length
				? `${q.text}\n\n${tags.map((h) => `#${h}`).join(" ")}`
				: q.text;
			for (const rule of routes) {
				const when = new Date(
					Date.now() + (rule.bufferMinutes + i * rule.gapMinutes) * 60_000,
				).toISOString();
				const n = await scheduleImageToAccounts(
					rule.profileId,
					user.id,
					caption,
					cardUrl,
					rule.accountIds,
					when,
				);
				scheduled += n;
				if (n === 0) failed++;
			}
		}
	}

	return { languages: targetLangs, rendered, scheduled, failed, items };
}

function toSaved(
	q: typeof quoteItems.$inferSelect,
	bgUrl: string | null,
	overlayUrl: string | null,
	cardUrl: string | null,
): SavedQuote {
	return {
		id: q.id,
		text: q.text,
		hashtags: q.hashtags ?? [],
		bgUrl,
		overlayUrl,
		cardUrl,
		panY: q.panY,
		zoom: q.zoom,
		batchId: q.batchId,
		outputLang: q.outputLang,
	};
}
