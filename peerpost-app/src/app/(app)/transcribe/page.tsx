import { desc, eq } from "drizzle-orm";
import { TranscribeStudio } from "@/components/transcribe-studio";
import { db } from "@/db";
import { transcriptJobs } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
import { corpusConfigured } from "@/lib/vertex-ingest";

/**
 * Transcribe: upload audio (or a Google Drive link) → split into N chunks →
 * Gemini transcribes each (with optional Tamil↔English translation) → saved,
 * editable, and pushable to the Vertex corpus for article generation.
 */
export default async function TranscribePage() {
	const user = await requirePageUser();
	const profiles = await getAccessibleProfiles(user);
	const [rows, ecosystems] = await Promise.all([
		db
			.select()
			.from(transcriptJobs)
			.where(eq(transcriptJobs.userId, user.id))
			.orderBy(desc(transcriptJobs.createdAt))
			.limit(100),
		Promise.all(
			profiles.map(async (p) => ({
				id: p.id,
				name: p.name,
				teamName: p.teamName,
				accounts: await getConnectedAccounts(p.id),
			})),
		),
	]);
	return (
		<TranscribeStudio
			initialJobs={rows}
			ecosystems={ecosystems}
			corpusReady={corpusConfigured()}
		/>
	);
}
