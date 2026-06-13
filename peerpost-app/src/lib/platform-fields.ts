/**
 * Declarative config of every PostPeer `platformSpecificData` field per
 * platform, rendered generically by the composer. Special cases handled in the
 * composer (not here): Pinterest `boardId` (dynamic select from the account's
 * boards), Twitter `poll`/`threadItems`, and the YouTube video thumbnail
 * (which is a mediaItem field, not platformSpecificData).
 */

export type FieldType =
	| "text"
	| "textarea"
	| "url"
	| "number"
	| "checkbox"
	| "select"
	| "tags"
	| "media-url"; // text URL with an "upload image" helper

export type FieldDef = {
	key: string;
	label: string;
	type: FieldType;
	options?: { value: string; label: string }[];
	placeholder?: string;
	help?: string;
	default?: string | boolean;
	max?: number;
};

export const PLATFORM_LABELS: Record<string, string> = {
	twitter: "Twitter / X",
	youtube: "YouTube",
	linkedin: "LinkedIn",
	pinterest: "Pinterest",
	bluesky: "Bluesky",
	tiktok: "TikTok",
	instagram: "Instagram",
	facebook: "Facebook",
	threads: "Threads",
};

/** Short badge codes, e.g. for dense tables. */
export const PLATFORM_SHORT: Record<string, string> = {
	twitter: "X",
	youtube: "YT",
	linkedin: "in",
	pinterest: "Pin",
	bluesky: "BS",
	tiktok: "TT",
	instagram: "IG",
	facebook: "FB",
	threads: "Th",
};

/** Media requirement per platform: "video", any "media", or "optional". */
export const PLATFORM_MEDIA: Record<string, "video" | "required" | "optional"> =
	{
		youtube: "video",
		pinterest: "required",
		tiktok: "required",
		instagram: "required",
		twitter: "optional",
		linkedin: "optional",
		facebook: "optional",
		bluesky: "optional",
		threads: "optional",
	};

export const CHAR_LIMITS: Record<string, number> = {
	twitter: 280,
	bluesky: 300,
};

export const PLATFORM_FIELDS: Record<string, FieldDef[]> = {
	youtube: [
		{
			key: "title",
			label: "Title",
			type: "text",
			max: 100,
			placeholder: "Defaults to your text",
		},
		{
			key: "tags",
			label: "Tags",
			type: "tags",
			placeholder: "comma, separated",
			help: "≤500 chars total",
		},
		{
			key: "visibility",
			label: "Visibility",
			type: "select",
			default: "public",
			options: [
				{ value: "public", label: "Public" },
				{ value: "unlisted", label: "Unlisted" },
				{ value: "private", label: "Private" },
			],
		},
		{
			key: "categoryId",
			label: "Category",
			type: "select",
			default: "22",
			options: [
				{ value: "1", label: "Film & Animation" },
				{ value: "10", label: "Music" },
				{ value: "20", label: "Gaming" },
				{ value: "22", label: "People & Blogs" },
				{ value: "27", label: "Education" },
				{ value: "28", label: "Science & Tech" },
			],
		},
		{ key: "madeForKids", label: "Made for kids (COPPA)", type: "checkbox" },
		{
			key: "containsSyntheticMedia",
			label: "Contains AI-generated media",
			type: "checkbox",
		},
		{
			key: "firstComment",
			label: "First comment",
			type: "textarea",
			max: 10000,
			placeholder: "Auto-posted after publish",
		},
	],
	twitter: [
		{
			key: "replySettings",
			label: "Who can reply",
			type: "select",
			options: [
				{ value: "", label: "Everyone" },
				{ value: "following", label: "Accounts you follow" },
				{ value: "mentionedUsers", label: "Mentioned only" },
				{ value: "subscribers", label: "Subscribers" },
				{ value: "verified", label: "Verified accounts" },
			],
		},
		{
			key: "replyToTweetId",
			label: "Reply to tweet ID",
			type: "text",
			placeholder: "Optional — makes this a reply",
		},
		{ key: "communityId", label: "Community ID", type: "text" },
		{
			key: "shareWithFollowers",
			label: "Share community post with followers",
			type: "checkbox",
		},
	],
	tiktok: [
		{
			key: "privacyLevel",
			label: "Privacy",
			type: "select",
			default: "PUBLIC_TO_EVERYONE",
			options: [
				{ value: "PUBLIC_TO_EVERYONE", label: "Public" },
				{ value: "MUTUAL_FOLLOW_FRIENDS", label: "Friends" },
				{ value: "FOLLOWER_OF_CREATOR", label: "Followers" },
				{ value: "SELF_ONLY", label: "Private" },
			],
		},
		{ key: "disableComment", label: "Disable comments", type: "checkbox" },
		{ key: "disableDuet", label: "Disable duet (video)", type: "checkbox" },
		{ key: "disableStitch", label: "Disable stitch (video)", type: "checkbox" },
		{
			key: "brandContentToggle",
			label: "Branded content (paid partnership)",
			type: "checkbox",
		},
		{
			key: "brandOrganicToggle",
			label: "Organic brand promotion",
			type: "checkbox",
		},
		{ key: "isAigc", label: "AI-generated content (video)", type: "checkbox" },
		{
			key: "videoCoverTimestampMs",
			label: "Cover frame (ms)",
			type: "number",
			placeholder: "1000",
		},
		{
			key: "autoAddMusic",
			label: "Auto-add music (photo carousels)",
			type: "checkbox",
			default: true,
		},
		{
			key: "photoCoverIndex",
			label: "Photo cover index",
			type: "number",
			placeholder: "0",
		},
		{ key: "draft", label: "Send to TikTok inbox as draft", type: "checkbox" },
	],
	pinterest: [
		// boardId handled specially in the composer (dynamic select).
		{
			key: "title",
			label: "Pin title",
			type: "text",
			max: 100,
			placeholder: "Defaults to first line",
		},
		{
			key: "link",
			label: "Destination link",
			type: "url",
			placeholder: "https://… (drives traffic)",
		},
		{ key: "altText", label: "Alt text", type: "textarea", max: 500 },
		{
			key: "dominantColor",
			label: "Placeholder color (hex)",
			type: "text",
			placeholder: "#6E7874",
		},
		{ key: "coverImageUrl", label: "Video cover image", type: "media-url" },
	],
	instagram: [
		{
			key: "shareToFeed",
			label: "Also show Reel in feed grid",
			type: "checkbox",
			default: true,
		},
		{ key: "coverUrl", label: "Video cover image", type: "media-url" },
		{
			key: "thumbOffset",
			label: "Cover frame (ms)",
			type: "number",
			help: "Ignored if cover image set",
		},
	],
	linkedin: [
		{
			key: "visibility",
			label: "Visibility",
			type: "select",
			default: "PUBLIC",
			options: [
				{ value: "PUBLIC", label: "Public" },
				{ value: "CONNECTIONS", label: "Connections only" },
			],
		},
		{
			key: "articleUrl",
			label: "Article / link URL",
			type: "url",
			help: "Turns post into a link share",
		},
		{ key: "articleTitle", label: "Link card title", type: "text", max: 400 },
		{
			key: "articleDescription",
			label: "Link card description",
			type: "textarea",
			max: 400,
		},
	],
	facebook: [
		{
			key: "link",
			label: "Link (text posts only)",
			type: "url",
			help: "Renders an Open Graph preview",
		},
		{ key: "videoThumbnailUrl", label: "Video thumbnail", type: "media-url" },
		{
			key: "published",
			label: "Publish now (uncheck = draft)",
			type: "checkbox",
			default: true,
		},
	],
	bluesky: [
		{
			key: "langs",
			label: "Languages",
			type: "tags",
			placeholder: "en, es",
			help: "BCP-47 tags; default en",
		},
		{
			key: "altText",
			label: "Alt text (one per image)",
			type: "tags",
			placeholder: "first, second",
		},
	],
	threads: [
		{
			key: "replyControl",
			label: "Who can reply",
			type: "select",
			default: "everyone",
			options: [
				{ value: "everyone", label: "Everyone" },
				{ value: "accounts_you_follow", label: "Accounts you follow" },
				{ value: "mentioned_only", label: "Mentioned only" },
			],
		},
		{
			key: "altText",
			label: "Alt text (one per image)",
			type: "tags",
			placeholder: "first, second",
		},
	],
};

/** Build a clean platformSpecificData object from raw option values. */
export function buildPlatformData(
	platform: string,
	raw: Record<string, unknown>,
): Record<string, unknown> | undefined {
	const fields = PLATFORM_FIELDS[platform] ?? [];
	const out: Record<string, unknown> = {};
	for (const f of fields) {
		const v = raw[f.key] ?? f.default;
		if (v === undefined || v === "" || v === null) continue;
		if (f.type === "checkbox") {
			out[f.key] = Boolean(v);
		} else if (f.type === "number") {
			const n = Number(v);
			if (!Number.isNaN(n)) out[f.key] = n;
		} else if (f.type === "tags") {
			const arr = String(v)
				.split(/[,\n]/)
				.map((s) => s.trim())
				.filter(Boolean);
			if (arr.length) out[f.key] = arr;
		} else {
			out[f.key] = v;
		}
	}
	return Object.keys(out).length ? out : undefined;
}
