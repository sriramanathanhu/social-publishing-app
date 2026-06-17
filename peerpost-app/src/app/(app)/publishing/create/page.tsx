import { and, eq } from "drizzle-orm";
import { CreatePost } from "@/components/create-post";
import { db } from "@/db";
import { type DubCaption, dubJobs } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

type PrefillMedia = {
	type: "image" | "video" | "gif";
	url: string;
	name: string;
};

// The composer uses one caption for all platforms, so pick a representative
// AI caption (a longer-form platform reads well everywhere) to pre-fill.
const CAPTION_PREFERENCE = ["instagram", "facebook", "youtube", "threads"];

function pickCaption(
	captions: Record<string, DubCaption> | null | undefined,
): string {
	if (!captions) return "";
	for (const p of CAPTION_PREFERENCE) {
		const c = captions[p]?.caption?.trim();
		if (c) return c;
	}
	// Fall back to any non-empty caption.
	for (const entry of Object.values(captions)) {
		const c = entry?.caption?.trim();
		if (c) return c;
	}
	return "";
}

/** Create Post: pick a profile, compose, publish or schedule. */
export default async function CreatePostPage({
	searchParams,
}: {
	searchParams: Promise<{ dub?: string; media?: string; text?: string }>;
}) {
	const user = await requirePageUser();
	const { dub, media, text } = await searchParams;

	const profiles = await getAccessibleProfiles(user);
	const withAccounts = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	// Optional: a finished dub handed over for publishing (?dub=<jobId>). The
	// dub page exports the video to PostPeer before redirecting here, so a done
	// job carries an outputUrl (pre-attached video) and AI captions (pre-filled
	// text) we can hand to the composer.
	let initialMedia: PrefillMedia[] = [];
	let initialContent = "";
	if (dub) {
		const job = await db.query.dubJobs.findFirst({
			where: and(eq(dubJobs.id, dub), eq(dubJobs.userId, user.id)),
		});
		if (job?.outputUrl) {
			initialMedia = [
				{
					type: "video",
					url: job.outputUrl,
					name: `dubbed-${job.targetLang}.mp4`,
				},
			];
			initialContent = pickCaption(job.captions);
		}
	}

	// Optional: a shorts clip handed over for publishing (?media=<r2 url>&text=).
	if (media && initialMedia.length === 0) {
		initialMedia = [{ type: "video", url: media, name: "short.mp4" }];
		initialContent = text ?? "";
	}

	return (
		<div className="space-y-5">
			<h1 className="text-xl font-semibold">Create Post</h1>
			{initialMedia.length > 0 && (
				<p className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">
					Your dubbed video is attached below
					{initialContent ? " with an AI-generated caption" : ""}. Pick an
					ecosystem, edit the caption, and publish.
				</p>
			)}
			<CreatePost
				profiles={withAccounts}
				initialMedia={initialMedia}
				initialContent={initialContent}
			/>
		</div>
	);
}
