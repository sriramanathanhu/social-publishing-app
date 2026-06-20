import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { DubStudio } from "@/components/dub-studio";
import { DubTable } from "@/components/dub-table";
import { db } from "@/db";
import { dubJobs } from "@/db/schema";
import { getUserKeyPresence } from "@/lib/api-keys";
import { reconcileRunningJobs } from "@/lib/dub-jobs";
import { dubPrefill } from "@/lib/dub-prefill";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
import { r2PublicUrl } from "@/lib/r2";
import { isApproved } from "@/lib/rbac";

/** Dub Video: submit a source, watch progress, then publish from a table. */
export default async function DubPage() {
	const user = await requirePageUser();
	const presence = await getUserKeyPresence(user.id);
	const keysReady = presence.deepgram && presence.gemini;

	await reconcileRunningJobs(user.id);

	const jobs = await db
		.select()
		.from(dubJobs)
		.where(eq(dubJobs.userId, user.id))
		.orderBy(desc(dubJobs.createdAt))
		.limit(20);

	const rows = jobs.map((j) => {
		const { title, caption } = dubPrefill(j.captions);
		return {
			id: j.id,
			status: j.status,
			targetLang: j.targetLang,
			createdAt:
				j.createdAt instanceof Date ? j.createdAt.toISOString() : j.createdAt,
			videoUrl: r2PublicUrl(j.archiveKey),
			title,
			caption,
		};
	});

	// Ecosystems (with accounts) the user can publish to.
	const profiles = await getAccessibleProfiles(user);
	const ecosystems = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Dub Video</h1>
				<p className="mt-1 text-sm opacity-60">
					Dub a video into another language, then publish it to an ecosystem
					straight from the table below.
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
				<>
					<DubStudio />
					<DubTable rows={rows} ecosystems={ecosystems} />
				</>
			)}
		</div>
	);
}
