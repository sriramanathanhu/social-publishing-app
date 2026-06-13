import { requirePageUser } from "@/lib/page-auth";
import Link from "next/link";
import { PostRow, shortDate } from "@/components/post-row";
import { getAnalytics, getPostsForUser } from "@/lib/queries";

/** Published-posts overview — intentionally compact, with cached metric badges. */
export default async function OverviewPage() {
	const user = await requirePageUser();

	const [posts, analytics] = await Promise.all([
		getPostsForUser(user, ["published", "failed", "publishing"]),
		getAnalytics(user),
	]);
	const metricsById = new Map(
		analytics.rows.map((r) => [
			r.postpeerPostId,
			{ likes: r.aggregated?.likes ?? null, views: r.aggregated?.views ?? null },
		]),
	);

	return (
		<div className="space-y-5">
			<div className="flex items-center justify-between">
				<h1 className="text-xl font-semibold">Published</h1>
				<Link
					href="/publishing/create"
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white"
				>
					+ Create Post
				</Link>
			</div>

			<ul className="space-y-2">
				{posts.length === 0 && (
					<li className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
						Nothing published yet. Create your first post.
					</li>
				)}
				{posts.map((p) => (
					<PostRow
						key={p.id}
						content={p.content}
						platforms={p.platforms}
						profileName={p.profileName}
						when={shortDate(p.createdAt)}
						status={p.status}
						metrics={p.postpeerPostId ? metricsById.get(p.postpeerPostId) : null}
					/>
				))}
			</ul>
		</div>
	);
}
