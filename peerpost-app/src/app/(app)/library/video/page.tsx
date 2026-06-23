import { desc, eq } from "drizzle-orm";
import { VideoLibrary } from "@/components/video-library";
import { db } from "@/db";
import { shortsClips, shortsJobs, userVideos } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Video: generated shorts clips + manually-uploaded videos (R2). */
export default async function VideoLibraryPage() {
	const user = await requirePageUser();
	const [clips, uploads] = await Promise.all([
		db
			.select({
				id: shortsClips.id,
				title: shortsClips.title,
				url: shortsClips.publicUrl,
				durationSec: shortsClips.durationSec,
				viralScore: shortsClips.viralScore,
			})
			.from(shortsClips)
			.innerJoin(shortsJobs, eq(shortsClips.jobId, shortsJobs.id))
			.where(eq(shortsJobs.userId, user.id))
			.orderBy(desc(shortsJobs.createdAt))
			.limit(300),
		db
			.select()
			.from(userVideos)
			.where(eq(userVideos.userId, user.id))
			.orderBy(desc(userVideos.createdAt))
			.limit(300),
	]);

	return (
		<VideoLibrary clips={clips.filter((c) => c.url)} initialUploads={uploads} />
	);
}
