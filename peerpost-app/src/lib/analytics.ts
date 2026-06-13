import { and, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import { analyticsSnapshots, postsLog } from "@/db/schema";
import { type AnalyticsPostResult, postpeer } from "@/lib/postpeer";

/**
 * Refresh cached analytics for the given ecosystems (profiles).
 *
 * PostPeer analytics are global to our key and cost 1 credit/call, so we fetch
 * the post list once (paginated, bounded) and upsert snapshots for the posts we
 * know about (matched to posts_log by postpeerPostId). Returns rows updated.
 */
const MAX_PAGES = 5; // bound credit usage: ≤5 calls, ≤500 posts per refresh

export async function refreshAnalytics(profileIds: string[]): Promise<number> {
	if (profileIds.length === 0) return 0;

	// Our published posts for these ecosystems that have a PostPeer id.
	const logs = await db
		.select({
			postpeerPostId: postsLog.postpeerPostId,
			profileId: postsLog.profileId,
			content: postsLog.content,
		})
		.from(postsLog)
		.where(
			and(
				inArray(postsLog.profileId, profileIds),
				isNotNull(postsLog.postpeerPostId),
			),
		);
	if (logs.length === 0) return 0;

	const wanted = new Map(logs.map((l) => [l.postpeerPostId as string, l]));

	// Page through the analytics list until we've covered everything (bounded).
	const byId = new Map<string, AnalyticsPostResult>();
	for (let page = 1; page <= MAX_PAGES; page++) {
		const res = await postpeer.getAnalyticsList({
			source: "postpeer",
			limit: 100,
			page,
		});
		for (const p of res.posts) if (p.postId) byId.set(p.postId, p);
		if (res.posts.length < 100 || page * 100 >= res.total) break;
	}

	const now = new Date();
	let updated = 0;
	for (const [postId, log] of wanted) {
		const a = byId.get(postId);
		if (!a) continue;
		await db
			.insert(analyticsSnapshots)
			.values({
				postpeerPostId: postId,
				profileId: log.profileId,
				content: a.content ?? log.content,
				publishedAt: a.publishedAt ? new Date(a.publishedAt) : null,
				aggregated: a.aggregated,
				platforms: a.platforms.map((p) => ({
					platform: p.platform,
					platformPostUrl: p.platformPostUrl,
					metrics: p.metrics,
				})),
				fetchedAt: now,
			})
			.onConflictDoUpdate({
				target: analyticsSnapshots.postpeerPostId,
				set: {
					content: a.content ?? log.content,
					publishedAt: a.publishedAt ? new Date(a.publishedAt) : null,
					aggregated: a.aggregated,
					platforms: a.platforms.map((p) => ({
						platform: p.platform,
						platformPostUrl: p.platformPostUrl,
						metrics: p.metrics,
					})),
					fetchedAt: now,
				},
			});
		updated++;
	}
	return updated;
}

/** Refresh analytics for every ecosystem (used by the scheduled job). */
export async function refreshAllAnalytics(): Promise<number> {
	const rows = await db
		.selectDistinct({ profileId: postsLog.profileId })
		.from(postsLog)
		.where(isNotNull(postsLog.postpeerPostId));
	return refreshAnalytics(rows.map((r) => r.profileId));
}
