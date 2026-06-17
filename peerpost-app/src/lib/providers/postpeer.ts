import { type CreatePostInput, type Platform, postpeer } from "@/lib/postpeer";
import type {
	ProviderCreatePost,
	ProviderPostResult,
	PublishProvider,
} from "@/lib/providers/types";

/**
 * PostPeer as a PublishProvider — a thin adapter over the existing lib/postpeer
 * client so the publish path can treat both providers uniformly. The legacy
 * direct calls still work; this just normalises the shape.
 */
export const postpeerProvider: PublishProvider = {
	name: "postpeer",

	async createPost(input: ProviderCreatePost): Promise<ProviderPostResult> {
		const payload: CreatePostInput = {
			content: input.content,
			platforms: input.platforms.map((p) => ({
				platform: p.platform as Platform,
				accountId: p.accountId,
				content: p.content,
				platformSpecificData: p.platformSpecificData,
			})),
			mediaItems: input.mediaItems,
			publishNow: input.publishNow,
			scheduledFor: input.scheduledFor,
			timezone: input.timezone,
		};
		const res = await postpeer.createPost(payload);
		return {
			success: res.success,
			postId: res.postId ?? null,
			status: res.status,
			message: res.message,
			platforms: res.platforms ?? [],
		};
	},

	async cancelScheduled(postId: string): Promise<void> {
		await postpeer.cancelScheduled(postId);
	},
};
