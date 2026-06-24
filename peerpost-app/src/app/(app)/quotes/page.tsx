import { and, desc, eq, isNotNull } from "drizzle-orm";
import { QuoteStudio } from "@/components/quote-studio";
import { db } from "@/db";
import {
	quoteBackgrounds,
	quoteItems,
	quoteOverlays,
	transcriptJobs,
} from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

/**
 * Quotes: paste long-form content → AI distills several powerful, postable
 * quotes (Gemini → NVIDIA). Each can be posted as text or as a branded image
 * card, published/scheduled to the viewer's ecosystems. Saved per user, so the
 * set (and any rendered cards) survives a refresh.
 */
export default async function QuotesPage() {
	const user = await requirePageUser();

	const profiles = await getAccessibleProfiles(user);
	const [ecosystems, backgrounds, overlays, items, transcripts] =
		await Promise.all([
			Promise.all(
				profiles.map(async (p) => ({
					id: p.id,
					name: p.name,
					teamName: p.teamName,
					accounts: await getConnectedAccounts(p.id),
				})),
			),
			db
				.select({
					id: quoteBackgrounds.id,
					url: quoteBackgrounds.url,
					label: quoteBackgrounds.label,
				})
				.from(quoteBackgrounds)
				.orderBy(desc(quoteBackgrounds.createdAt)),
			db
				.select({
					id: quoteOverlays.id,
					url: quoteOverlays.url,
					label: quoteOverlays.label,
					isDefault: quoteOverlays.isDefault,
				})
				.from(quoteOverlays)
				.orderBy(desc(quoteOverlays.isDefault), desc(quoteOverlays.createdAt)),
			db
				.select()
				.from(quoteItems)
				.where(eq(quoteItems.userId, user.id))
				.orderBy(desc(quoteItems.createdAt))
				.limit(120),
			db
				.select({
					id: transcriptJobs.id,
					title: transcriptJobs.title,
					transcript: transcriptJobs.transcript,
				})
				.from(transcriptJobs)
				// Transcripts are shared: anyone can generate quotes from any
				// finished transcript, not just the one who created it.
				.where(
					and(
						eq(transcriptJobs.status, "done"),
						isNotNull(transcriptJobs.transcript),
					),
				)
				.orderBy(desc(transcriptJobs.createdAt))
				.limit(100),
		]);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Quotes</h1>
				<p className="mt-1 text-sm opacity-60">
					Turn long-form content into powerful, ready-to-post quotes — as text
					or branded image cards — then publish or schedule them. Your set is
					saved.
				</p>
			</div>
			<QuoteStudio
				ecosystems={ecosystems}
				backgrounds={backgrounds}
				overlays={overlays}
				initialItems={items.map((i) => ({
					id: i.id,
					text: i.text,
					hashtags: i.hashtags ?? [],
					bgUrl: i.bgUrl,
					overlayUrl: i.overlayUrl,
					cardUrl: i.cardUrl,
					panY: i.panY,
					zoom: i.zoom,
					batchId: i.batchId,
				}))}
				transcripts={transcripts
					.filter((t) => t.transcript)
					.map((t) => ({
						id: t.id,
						title: t.title,
						transcript: t.transcript as string,
					}))}
			/>
		</div>
	);
}
