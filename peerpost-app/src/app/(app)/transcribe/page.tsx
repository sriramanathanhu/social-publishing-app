import { desc, eq } from "drizzle-orm";
import { TranscribeStudio } from "@/components/transcribe-studio";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { corpusConfigured } from "@/lib/vertex-ingest";

/**
 * Transcribe: upload audio (or a Google Drive link) → split into N chunks →
 * Gemini transcribes each (with optional Tamil↔English translation) → saved,
 * editable, and pushable to the Vertex corpus for article generation.
 */
export default async function TranscribePage() {
	const user = await requirePageUser();
	const rows = await db
		.select()
		.from(transcriptJobs)
		.where(eq(transcriptJobs.userId, user.id))
		.orderBy(desc(transcriptJobs.createdAt))
		.limit(100);
	return (
		<TranscribeStudio initialJobs={rows} corpusReady={corpusConfigured()} />
	);
}
