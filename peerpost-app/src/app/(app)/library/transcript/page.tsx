import { and, desc, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { TranscriptLibrary } from "@/components/transcript-library";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Transcript: final transcripts pushed to the GCS corpus. They live
 * in GCP (searchable for article generation) and are reflected here for reuse. */
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
		})
		.from(transcriptJobs)
		.where(
			and(
				eq(transcriptJobs.userId, user.id),
				isNotNull(transcriptJobs.pushedAt),
			),
		)
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
				tags: tags[t.id] ?? [],
			}))}
		/>
	);
}
