import { desc, eq, isNotNull } from "drizzle-orm";
import { type ArchiveItem, ArchiveTable } from "@/components/archive-table";
import { db } from "@/db";
import { dubJobs, shortsClips, shortsJobs } from "@/db/schema";
import { dubPrefill, languageLabel } from "@/lib/dub-prefill";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
import { r2PublicUrl } from "@/lib/r2";

/**
 * Archive: every dubbed + original (shorts) video generated across the team,
 * visible to all signed-in users. Each row publishes inline — but only to the
 * viewer's OWN assigned ecosystems (RBAC via getAccessibleProfiles).
 */
export default async function ArchivePage() {
	const user = await requirePageUser();

	// All finished dubs and all shorts clips with a public URL — every user's.
	const dubs = await db
		.select()
		.from(dubJobs)
		.where(eq(dubJobs.status, "done"))
		.orderBy(desc(dubJobs.createdAt))
		.limit(100);
	const clips = await db
		.select({
			id: shortsClips.id,
			title: shortsClips.title,
			description: shortsClips.description,
			publicUrl: shortsClips.publicUrl,
			createdAt: shortsClips.createdAt,
			settings: shortsJobs.settings,
		})
		.from(shortsClips)
		.innerJoin(shortsJobs, eq(shortsClips.jobId, shortsJobs.id))
		.where(isNotNull(shortsClips.publicUrl))
		.orderBy(desc(shortsClips.createdAt))
		.limit(100);

	const dubItems = dubs
		.map((d): { item: ArchiveItem; createdAt: Date } | null => {
			const videoUrl = r2PublicUrl(d.archiveKey);
			if (!videoUrl) return null;
			const { title, caption } = dubPrefill(d.captions);
			return {
				item: {
					key: `dub-${d.id}`,
					type: "Dubbed" as const,
					language: languageLabel(d.targetLang),
					title,
					caption,
					videoUrl,
				},
				createdAt: d.createdAt,
			};
		})
		.filter((x): x is { item: ArchiveItem; createdAt: Date } => x !== null);

	const clipItems = clips
		.filter((c) => c.publicUrl)
		.map((c): { item: ArchiveItem; createdAt: Date } => ({
			item: {
				key: `short-${c.id}`,
				type: "Original" as const,
				language: languageLabel(
					(c.settings as { language?: string } | null)?.language ?? "en",
				),
				title: c.title ?? "",
				caption: c.description ?? "",
				videoUrl: c.publicUrl as string,
			},
			createdAt: c.createdAt,
		}));

	const items = [...dubItems, ...clipItems]
		.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
		.map((x) => x.item);

	// Only the viewer's assigned ecosystems are publishable.
	const profiles = await getAccessibleProfiles(user);
	const ecosystems = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Archive</h1>
				<p className="mt-1 text-sm opacity-60">
					Every dubbed and original video generated across the team. Publish any
					of them to your assigned ecosystems.
				</p>
			</div>
			<ArchiveTable items={items} ecosystems={ecosystems} />
		</div>
	);
}
