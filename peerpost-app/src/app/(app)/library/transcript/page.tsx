import Link from "next/link";
import { TranscriptLibrary } from "@/components/transcript-library";
import { loadTranscriptsPage } from "@/lib/library-queries";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Transcript: every finished transcript (originals + translations),
 * shared across all users, with filters and server-side load-more. Pushed ones
 * are also searchable in the GCS corpus for article generation. */
export default async function TranscriptLibraryPage() {
	const user = await requirePageUser();
	const { items, hasMore } = await loadTranscriptsPage(user.id, 0);

	if (items.length === 0) {
		return (
			<p className="text-slate-400 text-sm">
				No transcripts yet. Create one under{" "}
				<Link href="/transcribe" className="text-blue-600 hover:underline">
					Content › Transcribe
				</Link>
				.
			</p>
		);
	}

	return <TranscriptLibrary items={items} hasMore={hasMore} />;
}
