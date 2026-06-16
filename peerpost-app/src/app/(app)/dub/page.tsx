import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { DubStudio } from "@/components/dub-studio";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { getUserKeyPresence } from "@/lib/api-keys";
import { reconcileRunningJobs } from "@/lib/dub-jobs";
import { requirePageUser } from "@/lib/page-auth";
import { isApproved } from "@/lib/rbac";

/** Dub Video: submit a source, watch progress, download the dubbed result. */
export default async function DubPage() {
	const user = await requirePageUser();
	const presence = await getUserKeyPresence(user.id);
	const keysReady = presence.deepgram && presence.gemini;

	// Catch up any jobs that finished while no SSE tab was open.
	await reconcileRunningJobs(user.id);

	const jobs = await db
		.select()
		.from(dubJobs)
		.where(eq(dubJobs.userId, user.id))
		.orderBy(desc(dubJobs.createdAt))
		.limit(20);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Dub Video</h1>
				<p className="mt-1 text-sm opacity-60">
					Dub a video into another language, then download or publish it.
				</p>
			</div>

			{!isApproved(user) ? (
				<p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
					Your account is awaiting approval before you can run dub jobs.
				</p>
			) : !keysReady ? (
				<p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
					Add your Deepgram and Gemini API keys in{" "}
					<Link href="/settings" className="font-medium underline">
						Settings
					</Link>{" "}
					to start dubbing.
				</p>
			) : (
				<DubStudio recentJobs={jobs} />
			)}
		</div>
	);
}
