import { redirect } from "next/navigation";
import { CancelPostButton } from "@/components/cancel-post-button";
import { PostRow, shortDate } from "@/components/post-row";
import { getCurrentUser } from "@/lib/auth";
import { getPostsForUser } from "@/lib/queries";

/** Queued / scheduled posts. */
export default async function ScheduledPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/");

	const posts = await getPostsForUser(user, ["scheduled"]);

	return (
		<div className="space-y-5">
			<h1 className="text-xl font-semibold">Scheduled</h1>

			<ul className="space-y-2">
				{posts.length === 0 && (
					<li className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
						No scheduled posts.
					</li>
				)}
				{posts.map((p) => (
					<PostRow
						key={p.id}
						content={p.content}
						platforms={p.platforms}
						profileName={p.profileName}
						when={shortDate(p.scheduledFor)}
						status={p.status}
						action={<CancelPostButton postId={p.id} />}
					/>
				))}
			</ul>
		</div>
	);
}
