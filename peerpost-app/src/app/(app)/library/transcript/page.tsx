import { desc, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { TranscriptLibrary } from "@/components/transcript-library";
import { db } from "@/db";
import { transcriptJobs, users } from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Transcript: final transcripts pushed to the GCS corpus, shared
 * across all users (they live in GCP and are searchable for article
 * generation). Reflected here for reuse by anyone. */
export default async function TranscriptLibraryPage() {
	const user = await requirePageUser();
	const rows = await db
		.select({
			id: transcriptJobs.id,
			title: transcriptJobs.title,
			outputLang: transcriptJobs.outputLang,
			corpusKey: transcriptJobs.corpusKey,
			pushedAt: transcriptJobs.pushedAt,
			transcript: transcriptJobs.transcript,
			authorName: users.name,
			authorEmail: users.email,
		})
		.from(transcriptJobs)
		.innerJoin(users, eq(transcriptJobs.userId, users.id))
		.where(isNotNull(transcriptJobs.pushedAt))
		.orderBy(desc(transcriptJobs.pushedAt))
		.limit(300);

	if (rows.length === 0) {
		return (
			<p className="text-slate-400 text-sm">
				No transcripts pushed to the corpus yet. Push a finished transcript
				under{" "}
				<Link href="/transcribe" className="text-blue-600 hover:underline">
					Content › Transcribe
				</Link>
				.
			</p>
		);
	}

	const tags = await loadTags(
		user.id,
		"transcript",
		rows.map((r) => r.id),
	);

	return (
		<TranscriptLibrary
			items={rows.map((t) => ({
				id: t.id,
				title: t.title,
				lang: t.outputLang,
				corpusKey: t.corpusKey,
				pushedAt: t.pushedAt ? String(t.pushedAt) : null,
				transcript: t.transcript ?? "",
				author: t.authorName || t.authorEmail || "",
				tags: tags[t.id] ?? [],
			}))}
		/>
	);
}
