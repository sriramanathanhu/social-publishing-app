/**
 * Provider abstraction for publishing.
 *
 * PeerPost publishes through more than one upstream API (PostPeer and Zernio).
 * Both speak a near-identical "create post" shape, so we normalise them behind
 * one interface and route each account to its provider at publish time. The
 * provider that owns an account is recorded on integrations_cache.provider.
 */

export type ProviderName = "postpeer" | "zernio";

export type ProviderPlatformTarget = {
	platform: string;
	accountId: string;
	content?: string;
	platformSpecificData?: Record<string, unknown>;
};

export type ProviderMediaItem = {
	type: "image" | "video" | "gif";
	url: string;
	thumbnail?: string;
};

export type ProviderCreatePost = {
	content: string;
	platforms: ProviderPlatformTarget[];
	mediaItems?: ProviderMediaItem[];
	publishNow?: boolean;
	scheduledFor?: string; // ISO 8601
	timezone?: string;
	// Some providers (Zernio) require the profile id in the post body.
	profileExternalId?: string;
};

export type ProviderPostResult = {
	success: boolean;
	postId: string | null;
	status?: string; // published | scheduled | failed | partial ...
	message?: string;
	platforms: {
		platform: string;
		success: boolean;
		error?: string;
		url?: string;
	}[];
};

/** The publish surface every provider must implement. */
export interface PublishProvider {
	readonly name: ProviderName;
	createPost(input: ProviderCreatePost): Promise<ProviderPostResult>;
	cancelScheduled(postId: string): Promise<void>;
}
