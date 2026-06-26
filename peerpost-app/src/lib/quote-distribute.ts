import "server-only";
import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
	quoteBackgrounds,
	quoteDistributions,
	quoteItems,
	quoteOverlays,
} from "@/db/schema";
import { getUserKeys } from "@/lib/api-keys";
import type { AppUser } from "@/lib/auth";
import { getAccessibleProfiles } from "@/lib/queries";
import {
	type SavedQuote,
	scheduleImageToAccounts,
} from "@/lib/quote-autopublish";
import { renderQuoteCard } from "@/lib/quote-card";
import { generateQuotes } from "@/lib/quotes";

export type DistributeInput = {
	content: string;
	count: number;
	tone?: string;
	distributionId: string;
};

/**
 * Cheap up-front validation (no Gemini / no rendering) so the route can return
 * obvious config errors synchronously before backgrounding the slow work.
 * Returns the number of distinct reachable ecosystems on success.
 */
export async function preflightDistribute(
	user: AppUser,
	input: { distributionId: string },
): Promise<{ error?: string; ecosystems?: number }> {
	const dist = await db.query.quoteDistributions.findFirst({
		where: and(
			eq(quoteDistributions.id, input.distributionId),
			eq(quoteDistributions.userId, user.id),
		),
	});
	if (!dist) return { error: "Distribution list not found." };

	const accessible = new Set(
		(await getAccessibleProfiles(user)).map((p) => p.id),
	);
	const ecos = new Set(
		dist.targets
			.filter((t) => accessible.has(t.profileId))
			.map((t) => t.profileId),
	);
	if (ecos.size === 0) return { error: "No reachable targets in this list." };

	const [bg] = await db
		.select({ url: quoteBackgrounds.url })
		.from(quoteBackgrounds)
		.limit(1);
	if (!bg?.url)
		return { error: "Add at least one Quote background to the library first." };

	return { ecosystems: ecos.size };
}

/**
 * "Generate & distribute": generate a pool of `count` single-language cards,
 * render each, then SPREAD them across the saved list's ECOSYSTEMS — each
 * ecosystem gets a distinct slice of `cardsPerTarget` cards (no repeats across
 * ecosystems), and every card in a slice is broadcast to ALL that ecosystem's
 * selected accounts, drip-spaced (first at +buffer, then every +gap). One auth
 * check (the route's requireUser). Returns a summary.
 */
export async function distributeQuotes(
	user: AppUser,
	input: DistributeInput,
): Promise<{
	generated: number;
	rendered: number;
	scheduled: number;
	ecosystems: number;
	failed: number;
	items: SavedQuote[];
	error?: string;
}> {
	const empty = {
		generated: 0,
		rendered: 0,
		scheduled: 0,
		ecosystems: 0,
		failed: 0,
		items: [] as SavedQuote[],
	};

	const dist = await db.query.quoteDistributions.findFirst({
		where: and(
			eq(quoteDistributions.id, input.distributionId),
			eq(quoteDistributions.userId, user.id),
		),
	});
	if (!dist) return { ...empty, error: "Distribution list not found." };

	// Only keep targets in ecosystems the user can still publish to.
	const accessible = new Set(
		(await getAccessibleProfiles(user)).map((p) => p.id),
	);
	const targets = dist.targets.filter((t) => accessible.has(t.profileId));
	if (targets.length === 0)
		return { ...empty, error: "No reachable targets in this list." };

	// Card style: rotate library backgrounds + the default overlay.
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

	// Generate the pool.
	const keys = await getUserKeys(user.id);
	let gen: Awaited<ReturnType<typeof generateQuotes>>;
	try {
		gen = await generateQuotes(input.content, {
			geminiKey: keys.gemini,
			nvidiaKey: keys.nvidia,
			count: input.count,
			tone: input.tone,
			outputLang: dist.lang,
		});
	} catch (e) {
		return {
			...empty,
			error: e instanceof Error ? e.message : "Generation failed",
		};
	}
	if (gen.quotes.length === 0)
		return { ...empty, error: "No quotes were generated — try more content." };

	const batchId = randomUUID();
	const saved = await db
		.insert(quoteItems)
		.values(
			gen.quotes.map((q) => ({
				userId: user.id,
				text: q.text,
				hashtags: q.hashtags,
				batchId,
				outputLang: dist.lang,
			})),
		)
		.returning();

	// Render the whole pool (rotating backgrounds).
	const rendered: {
		item: (typeof saved)[number];
		cardUrl: string;
		bg: string;
	}[] = [];
	let failed = 0;
	for (let i = 0; i < saved.length; i++) {
		const q = saved[i];
		const bg = bgPool[i % bgPool.length];
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
			continue;
		}
		await db
			.update(quoteItems)
			.set({ cardUrl, bgUrl: bg, overlayUrl: overlayUrl ?? null })
			.where(eq(quoteItems.id, q.id));
		rendered.push({ item: q, cardUrl, bg });
	}

	// Group the selected accounts BY ECOSYSTEM (preserving first-seen order).
	const byEco = new Map<string, string[]>();
	const ecoOrder: string[] = [];
	for (const t of targets) {
		if (!byEco.has(t.profileId)) {
			byEco.set(t.profileId, []);
			ecoOrder.push(t.profileId);
		}
		byEco.get(t.profileId)?.push(t.accountId);
	}

	// SPREAD per ECOSYSTEM: each ecosystem gets a distinct slice of cardsPerTarget
	// cards (no repeats across ecosystems); every card in the slice is broadcast
	// to ALL of that ecosystem's selected accounts, drip-spaced (card j at
	// +buffer + j*gap).
	const per = dist.cardsPerTarget;
	let idx = 0;
	let scheduled = 0;
	let usedEcosystems = 0;
	for (const profileId of ecoOrder) {
		if (idx >= rendered.length) break; // pool exhausted
		const accountIds = byEco.get(profileId) ?? [];
		const slice = rendered.slice(idx, idx + per);
		idx += slice.length;
		usedEcosystems++;
		for (let j = 0; j < slice.length; j++) {
			const card = slice[j];
			const tags = card.item.hashtags ?? [];
			const caption = tags.length
				? `${card.item.text}\n\n${tags.map((h) => `#${h}`).join(" ")}`
				: card.item.text;
			const when = new Date(
				Date.now() + (dist.bufferMinutes + j * dist.gapMinutes) * 60_000,
			).toISOString();
			const n = await scheduleImageToAccounts(
				profileId,
				user.id,
				caption,
				card.cardUrl,
				accountIds,
				when,
			);
			scheduled += n;
			if (n === 0) failed++;
		}
	}

	const items: SavedQuote[] = rendered.map((r) => ({
		id: r.item.id,
		text: r.item.text,
		hashtags: r.item.hashtags ?? [],
		bgUrl: r.bg,
		overlayUrl: overlayUrl ?? null,
		cardUrl: r.cardUrl,
		panY: r.item.panY,
		zoom: r.item.zoom,
		batchId: r.item.batchId,
		outputLang: r.item.outputLang,
	}));

	return {
		generated: saved.length,
		rendered: rendered.length,
		scheduled,
		ecosystems: usedEcosystems,
		failed,
		items,
	};
}
