import { and, desc, eq, isNotNull } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Transcript: final transcripts pushed to the GCS corpus. They live
 * in GCP (searchable by article generation) and are reflected here for reuse. */
export default async function TranscriptLibraryPage() {
	const user = await requirePageUser();
	const rows = await db
		.select({
			id: transcriptJobs.id,
			title: transcriptJobs.title,
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

	return (
		<div className="space-y-3">
			{rows.map((t) => (
				<details
					key={t.id}
					className="rounded-lg border border-slate-200 bg-white p-4"
				>
					<summary className="cursor-pointer font-medium text-slate-900">
						{t.title}
						<span className="ml-2 font-normal text-slate-400 text-xs">
							in corpus ·{" "}
							{t.pushedAt ? new Date(t.pushedAt).toLocaleString() : ""} ·{" "}
							{t.corpusKey}
						</span>
					</summary>
					<div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-slate-700 text-sm">
						{t.transcript}
					</div>
				</details>
			))}
		</div>
	);
}
