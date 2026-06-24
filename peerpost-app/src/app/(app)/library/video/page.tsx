import { and, desc, eq, isNotNull } from "drizzle-orm";
import { VideoLibrary } from "@/components/video-library";
import { db } from "@/db";
import {
	dubJobs,
	shortsClips,
	shortsJobs,
	users,
	userVideos,
} from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
import { r2PublicUrl } from "@/lib/r2";

const who = (name: string | null, email: string | null) =>
	name?.trim() || email?.trim() || "Unknown";

/** Library › Video: a SHARED gallery of every user's generated shorts, uploaded
 * videos and dubbed outputs — with tags, "dubbed" links, bulk publish, and
 * filters by date, language (shorts/dub output) and the user who made it. */
export default async function VideoLibraryPage() {
	const user = await requirePageUser();
	const [uploadRows, clipRows, dubRows, profiles] = await Promise.all([
		db
			.select({
				id: userVideos.id,
				title: userVideos.title,
				url: userVideos.url,
				createdAt: userVideos.createdAt,
				userName: users.name,
				userEmail: users.email,
			})
			.from(userVideos)
			.innerJoin(users, eq(userVideos.userId, users.id))
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
				settings: shortsJobs.settings,
				userName: users.name,
				userEmail: users.email,
			})
			.from(shortsClips)
			.innerJoin(shortsJobs, eq(shortsClips.jobId, shortsJobs.id))
			.innerJoin(users, eq(shortsJobs.userId, users.id))
			.orderBy(desc(shortsJobs.createdAt))
			.limit(300),
		db
			.select({
				id: dubJobs.id,
				targetLang: dubJobs.targetLang,
				archiveKey: dubJobs.archiveKey,
				sourceLibraryId: dubJobs.sourceLibraryId,
				createdAt: dubJobs.createdAt,
				userName: users.name,
				userEmail: users.email,
			})
			.from(dubJobs)
			.innerJoin(users, eq(dubJobs.userId, users.id))
			.where(and(eq(dubJobs.status, "done"), isNotNull(dubJobs.archiveKey)))
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
			userName: who(d.userName, d.userEmail),
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
			me={who(user.name, user.email)}
			uploads={uploadRows.map((u) => ({
				id: u.id,
				kind: "video" as const,
				title: u.title,
				url: u.url,
				tags: uploadTags[u.id] ?? [],
				createdAt: String(u.createdAt),
				userName: who(u.userName, u.userEmail),
				lang: null,
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
					userName: who(c.userName, c.userEmail),
					lang: (c.settings?.language as string | undefined) ?? null,
				}))}
			dubs={dubs.map((d) => ({
				id: d.id,
				kind: "dub" as const,
				title: `Dubbed → ${d.targetLang}`,
				url: d.url as string,
				tags: dubTags[d.id] ?? [],
				createdAt: String(d.createdAt),
				userName: d.userName,
				lang: d.targetLang,
			}))}
		/>
	);
}
