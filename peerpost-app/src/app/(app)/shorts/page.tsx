import { desc, eq, inArray } from "drizzle-orm";
import Link from "next/link";
import { ShortsAssets } from "@/components/shorts-assets";
import { ShortsDistributions } from "@/components/shorts-distributions";
import { ShortsStudio } from "@/components/shorts-studio";
import { ShortsTable } from "@/components/shorts-table";
import { db } from "@/db";
import { shortsClips, shortsJobs } from "@/db/schema";
import { getUserKeyPresence } from "@/lib/api-keys";
import { getUserAssets } from "@/lib/assets";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
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

	// FIFO position in the shared shorts/transcribe pool (4 process at a time).
	// #1 = next to start. Computed across all users since the pool is global.
	const queuedRows = await db
		.select({ id: shortsJobs.id })
		.from(shortsJobs)
		.where(eq(shortsJobs.status, "queued"))
		.orderBy(shortsJobs.createdAt);
	const queuePos = new Map(queuedRows.map((q, i) => [q.id, i + 1]));
	const queueTotal = queuedRows.length;

	const assets = await getUserAssets(user.id);
	const jobIds = jobs.map((j) => j.id);
	const clips = jobIds.length
		? await db
				.select()
				.from(shortsClips)
				.where(inArray(shortsClips.jobId, jobIds))
				.orderBy(shortsClips.idx)
		: [];

	// Ecosystems (with accounts) the user can publish clips to.
	const profiles = await getAccessibleProfiles(user);
	const ecosystems = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	const jobRows = jobs.map((j) => ({
		id: j.id,
		name: j.name,
		status: j.status,
		sourceInput: j.sourceInput,
		numClips: j.numClips,
		error: j.error,
		createdAt:
			j.createdAt instanceof Date ? j.createdAt.toISOString() : j.createdAt,
		completedAt: j.completedAt
			? j.completedAt instanceof Date
				? j.completedAt.toISOString()
				: j.completedAt
			: null,
		queuePosition: j.status === "queued" ? (queuePos.get(j.id) ?? null) : null,
	}));

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Shorts</h1>
				<p className="mt-1 text-sm opacity-60">
					Turn one long video into many short clips — AI finds the moments,
					auto-frames the speaker, writes a title + caption, and you publish
					each straight from the table.
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
				<>
					<ShortsAssets assets={assets} />
					<ShortsDistributions ecosystems={ecosystems} />
					<ShortsStudio />
					<ShortsTable
						jobs={jobRows}
						clips={clips}
						ecosystems={ecosystems}
						queueTotal={queueTotal}
					/>
				</>
			)}
		</div>
	);
}
