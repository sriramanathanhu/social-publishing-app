import { VideoLibrary } from "@/components/video-library";
import { loadDubBySource, loadVideoPage } from "@/lib/library-queries";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

const who = (name: string | null, email: string | null) =>
	name?.trim() || email?.trim() || "Unknown";

/** Library › Video: a SHARED gallery of every user's generated shorts, uploaded
 * videos and dubbed outputs — with tags, "dubbed" links, bulk publish, bulk
 * dub, filters (date / language / user) and server-side load-more. */
export default async function VideoLibraryPage() {
	const user = await requirePageUser();
	const [{ items, hasMore }, dubBySource, profiles] = await Promise.all([
		loadVideoPage(user.id, 0),
		loadDubBySource(),
		getAccessibleProfiles(user),
	]);

	const ecosystems = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	return (
		<VideoLibrary
			items={items}
			hasMore={hasMore}
			dubBySource={dubBySource}
			ecosystems={ecosystems}
			me={who(user.name, user.email)}
		/>
	);
}
