import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { ShortsStudio } from "@/components/shorts-studio";
import { db } from "@/db";
import { shortsClips, shortsJobs } from "@/db/schema";
import { getUserKeyPresence } from "@/lib/api-keys";
import { requirePageUser } from "@/lib/page-auth";
import { isApproved } from "@/lib/rbac";
import { reconcileRunningShorts } from "@/lib/shorts-jobs";

/** Shorts: turn one long video into many short clips with AI titles. */
export default async function ShortsPage() {
	const user = await requirePageUser();
	const presence = await getUserKeyPresence(user.id);
	const keysReady = presence.deepgram && presence.nvidia;

	// Catch up any jobs that finished while no SSE tab was open.
	await reconcileRunningShorts(user.id);

	const jobs = await db
		.select()
		.from(shortsJobs)
		.where(eq(shortsJobs.userId, user.id))
		.orderBy(desc(shortsJobs.createdAt))
		.limit(20);

	const jobIds = jobs.map((j) => j.id);
	const clips = jobIds.length
		? await db
				.select()
				.from(shortsClips)
				.where(inArray(shortsClips.jobId, jobIds))
				.orderBy(shortsClips.idx)
		: [];

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Shorts</h1>
				<p className="mt-1 text-sm opacity-60">
					Turn one long video into {`{N}`} short clips — AI finds the moments,
					crops to 9:16, and writes a title + description for each.
				</p>
			</div>

			{!isApproved(user) ? (
				<p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
					Your account is awaiting approval before you can run shorts jobs.
				</p>
			) : !keysReady ? (
				<p className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-amber-800">
					Add your Deepgram and NVIDIA API keys in{" "}
					<Link href="/settings" className="font-medium underline">
						Settings
					</Link>{" "}
					to start generating shorts.
				</p>
			) : (
				<ShortsStudio recentJobs={jobs} clips={clips} />
			)}
		</div>
	);
}
