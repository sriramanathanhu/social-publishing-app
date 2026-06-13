import { AnalyticsDashboard } from "@/components/analytics-dashboard";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getAnalytics } from "@/lib/queries";

/** Publishing → Analytics: cached post-level metrics across accessible ecosystems. */
export default async function AnalyticsPage() {
	const user = await requirePageUser();

	const [{ rows, lastFetched }, profiles] = await Promise.all([
		getAnalytics(user),
		getAccessibleProfiles(user),
	]);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Analytics</h1>
				<p className="text-sm opacity-60">
					Post performance from PostPeer. Cached locally; click Refresh to pull
					the latest (some metrics populate slowly on each platform).
				</p>
			</div>

			<AnalyticsDashboard
				rows={rows.map((r) => ({
					postpeerPostId: r.postpeerPostId,
					profileId: r.profileId,
					profileName: r.profileName,
					content: r.content,
					publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
					aggregated: r.aggregated,
					platforms: r.platforms,
				}))}
				ecosystems={profiles.map((p) => ({ id: p.id, name: p.name }))}
				lastFetched={lastFetched ? lastFetched.toISOString() : null}
			/>
		</div>
	);
}
