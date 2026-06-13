import { requirePageUser } from "@/lib/page-auth";
import { CreatePost } from "@/components/create-post";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

/** Create Post: pick a profile, compose, publish or schedule. */
export default async function CreatePostPage() {
	const user = await requirePageUser();

	const profiles = await getAccessibleProfiles(user);
	const withAccounts = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	return (
		<div className="space-y-5">
			<h1 className="text-xl font-semibold">Create Post</h1>
			<CreatePost profiles={withAccounts} />
		</div>
	);
}
