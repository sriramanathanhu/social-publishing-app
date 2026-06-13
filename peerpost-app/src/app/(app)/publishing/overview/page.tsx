import Link from "next/link";
import { redirect } from "next/navigation";
import { PostRow, shortDate } from "@/components/post-row";
import { getCurrentUser } from "@/lib/auth";
import { getPostsForUser } from "@/lib/queries";

/** Published-posts overview — intentionally compact. */
export default async function OverviewPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/");

	const posts = await getPostsForUser(user, ["published", "failed", "publishing"]);

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
					/>
				))}
			</ul>
		</div>
	);
}
