import { and, desc, eq, isNotNull } from "drizzle-orm";
import { VideoLibrary } from "@/components/video-library";
import { db } from "@/db";
import { dubJobs, shortsClips, shortsJobs, userVideos } from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
import { r2PublicUrl } from "@/lib/r2";

/** Library › Video: generated shorts clips + uploaded videos + dubbed outputs,
 * with tags/filter/sort, "dubbed" links, and bulk publish. */
export default async function VideoLibraryPage() {
	const user = await requirePageUser();
	const [uploadRows, clipRows, dubRows, profiles] = await Promise.all([
		db
			.select()
			.from(userVideos)
			.where(eq(userVideos.userId, user.id))
			.orderBy(desc(userVideos.createdAt))
			.limit(300),
		db
			.select({
				id: shortsClips.id,
				title: shortsClips.title,
				url: shortsClips.publicUrl,
				durationSec: shortsClips.durationSec,
				viralScore: shortsClips.viralScore,
				createdAt: shortsJobs.createdAt,
			})
			.from(shortsClips)
			.innerJoin(shortsJobs, eq(shortsClips.jobId, shortsJobs.id))
			.where(eq(shortsJobs.userId, user.id))
			.orderBy(desc(shortsJobs.createdAt))
			.limit(300),
		db
			.select({
				id: dubJobs.id,
				targetLang: dubJobs.targetLang,
				archiveKey: dubJobs.archiveKey,
				sourceLibraryId: dubJobs.sourceLibraryId,
				createdAt: dubJobs.createdAt,
			})
			.from(dubJobs)
			.where(
				and(
					eq(dubJobs.userId, user.id),
					eq(dubJobs.status, "done"),
					isNotNull(dubJobs.archiveKey),
				),
			)
			.orderBy(desc(dubJobs.createdAt))
			.limit(300),
		getAccessibleProfiles(user),
	]);

	const ecosystems = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	const dubs = dubRows
		.map((d) => ({
			id: d.id,
			targetLang: d.targetLang,
			url: r2PublicUrl(d.archiveKey),
			sourceLibraryId: d.sourceLibraryId,
			createdAt: d.createdAt,
		}))
		.filter((d) => d.url);

	// source item id → its dubbed outputs (lang + url)
	const dubBySource: Record<string, { lang: string; url: string }[]> = {};
	for (const d of dubs) {
		if (d.sourceLibraryId && d.url)
			(dubBySource[d.sourceLibraryId] ??= []).push({
				lang: d.targetLang,
				url: d.url,
			});
	}

	const [uploadTags, shortTags, dubTags] = await Promise.all([
		loadTags(
			user.id,
			"video",
			uploadRows.map((u) => u.id),
		),
		loadTags(
			user.id,
			"short",
			clipRows.map((c) => c.id),
		),
		loadTags(
			user.id,
			"dub",
			dubs.map((d) => d.id),
		),
	]);

	return (
		<VideoLibrary
			ecosystems={ecosystems}
			dubBySource={dubBySource}
			uploads={uploadRows.map((u) => ({
				id: u.id,
				kind: "video" as const,
				title: u.title,
				url: u.url,
				tags: uploadTags[u.id] ?? [],
				createdAt: String(u.createdAt),
			}))}
			shorts={clipRows
				.filter((c) => c.url)
				.map((c) => ({
					id: c.id,
					kind: "short" as const,
					title: c.title ?? "Short clip",
					url: c.url as string,
					durationSec: c.durationSec,
					viralScore: c.viralScore,
					tags: shortTags[c.id] ?? [],
					createdAt: String(c.createdAt),
				}))}
			dubs={dubs.map((d) => ({
				id: d.id,
				kind: "dub" as const,
				title: `Dubbed → ${d.targetLang}`,
				url: d.url as string,
				tags: dubTags[d.id] ?? [],
				createdAt: String(d.createdAt),
			}))}
		/>
	);
}
