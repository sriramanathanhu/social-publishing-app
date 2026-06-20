import { HttpError } from "@/lib/auth";

/**
 * Thin server-side client for the PostPeer API.
 *
 * The API key is shared across the whole platform and lives ONLY here, on the
 * server. It must never be sent to the browser. Tenant isolation is enforced by
 * our own RBAC layer (see lib/rbac.ts) before any of these methods are called.
 */

const BASE_URL = process.env.POSTPEER_BASE_URL ?? "https://api.postpeer.dev/v1";

function apiKey(): string {
	const key = process.env.POSTPEER_API_KEY;
	if (!key) throw new Error("POSTPEER_API_KEY is not set");
	return key;
}

async function request<T>(
	path: string,
	init: RequestInit & { query?: Record<string, string | undefined> } = {},
): Promise<T> {
	const { query, ...rest } = init;
	const url = new URL(`${BASE_URL}${path}`);
	if (query) {
		for (const [k, v] of Object.entries(query)) {
			if (v !== undefined) url.searchParams.set(k, v);
		}
	}

	const res = await fetch(url, {
		...rest,
		headers: {
			"x-access-key": apiKey(),
			"Content-Type": "application/json",
			...(rest.headers ?? {}),
		},
		cache: "no-store",
		// Cap so a slow provider can't hang a background publish forever.
		signal: AbortSignal.timeout(120_000),
	});

	const text = await res.text();
	const body = text ? JSON.parse(text) : null;

	if (!res.ok) {
		const message =
			body?.message ?? body?.error ?? `PostPeer error ${res.status}`;
		throw new HttpError(res.status, message);
	}
	return body as T;
}

// ── Types (partial — extend as you adopt more of the API) ───────────────────

export const PLATFORMS = [
	"twitter",
	"youtube",
	"linkedin",
	"pinterest",
	"bluesky",
	"tiktok",
	"instagram",
	"facebook",
	"threads",
] as const;
export type Platform = (typeof PLATFORMS)[number];

export type PostPeerProfile = {
	id: string;
	name: string;
	description?: string;
	integrationCount?: number;
};

/**
 * Real shape from GET /connect/integrations. NOTE: the value used as
 * `accountId` in POST /posts is the integration's `id` (verified against the
 * live API) — NOT `platformUserId`.
 */
export type PostPeerIntegration = {
	id: string;
	platform: Platform;
	platformUserId?: string;
	username?: string;
	displayName?: string;
	imageUrl?: string;
	profileUrl?: string;
	profileId?: string | null;
	byok?: boolean;
};

export type PostPlatformInput = {
	platform: Platform;
	accountId: string;
	content?: string;
	platformSpecificData?: Record<string, unknown>;
};

export type MediaItem = {
	type: "image" | "video" | "gif";
	url: string;
	thumbnail?: string;
};

export type CreatePostInput = {
	content: string;
	platforms: PostPlatformInput[];
	mediaItems?: MediaItem[];
	publishNow?: boolean;
	scheduledFor?: string; // ISO 8601
	timezone?: string;
};

export type PostPeerPost = { id: string; status?: string };

/**
 * Result of POST /posts/. NOTE: PostPeer returns HTTP 202 (a 2xx!) even when a
 * platform FAILS, with `success:false` and per-platform results — so callers
 * must inspect `success` / `platforms[].success`, not just the HTTP status.
 */
export type CreatePostResult = {
	success: boolean;
	status?: string; // "published" | "scheduled" | "failed" | "partial" ...
	postId?: string;
	message?: string;
	platforms?: {
		platform: string;
		success: boolean;
		error?: string;
		url?: string;
	}[];
};

export type PinterestBoard = { id: string; name: string; privacy?: string };

export type AnalyticsMetrics = {
	impressions: number | null;
	reach: number | null;
	likes: number | null;
	comments: number | null;
	shares: number | null;
	saves: number | null;
	clicks: number | null;
	views: number | null;
	engagementRate: number | null;
};

export type AnalyticsPostResult = {
	source: string;
	postId: string | null;
	content: string | null;
	publishedAt: string | null;
	aggregated: AnalyticsMetrics;
	platforms: {
		platform: string;
		platformPostId: string;
		platformPostUrl: string | null;
		metrics: AnalyticsMetrics;
	}[];
};

export type PresignResponse = { uploadUrl: string; publicUrl: string };

// ── API surface ─────────────────────────────────────────────────────────────
// Response envelopes are {success, <payload>}; helpers below unwrap them.

export const postpeer = {
	healthAuth: () => request<{ ok: boolean }>("/health/auth"),

	createProfile: async (input: { name: string; description?: string }) => {
		const res = await request<{ success: boolean; profile: PostPeerProfile }>(
			"/profiles/",
			{ method: "POST", body: JSON.stringify(input) },
		);
		return res.profile;
	},

	deleteProfile: (id: string) =>
		request<unknown>(`/profiles/${id}`, { method: "DELETE" }),

	/** Returns the hosted OAuth URL to send the user to for a given platform. */
	getConnectUrl: (
		platform: Platform,
		opts: { profileId: string; redirectUri: string; appId?: string },
	) =>
		request<{ url: string }>(`/connect/${platform}`, {
			query: {
				profileId: opts.profileId,
				redirectUri: opts.redirectUri,
				appId: opts.appId,
			},
		}),

	listIntegrations: () =>
		request<{
			success: boolean;
			total: number;
			integrations: PostPeerIntegration[];
		}>("/connect/integrations"),

	disconnectIntegration: (id: string) =>
		request<unknown>(`/connect/integrations/${id}`, { method: "DELETE" }),

	/** Returns the full result envelope; the route decides success per `success`. */
	createPost: (input: CreatePostInput) =>
		request<CreatePostResult>("/posts/", {
			method: "POST",
			body: JSON.stringify(input),
		}),

	/** Pinterest boards for a connected account (needed: boardId is required). */
	getPinterestBoards: (accountId: string) =>
		request<{ success: boolean; boards: PinterestBoard[] }>(
			"/pinterest/boards",
			{
				query: { accountId },
			},
		),

	cancelScheduled: (postId: string) =>
		request<unknown>(`/posts/scheduled/${postId}`, { method: "DELETE" }),

	reschedule: (postId: string, scheduledFor: string) =>
		request<unknown>(`/posts/scheduled/${postId}`, {
			method: "PATCH",
			body: JSON.stringify({ scheduledFor }),
		}),

	/** Post-level analytics list (source=postpeer). Costs 1 credit per call. */
	getAnalyticsList: (opts: {
		source?: "postpeer" | "platform";
		limit?: number;
		page?: number;
		sortBy?: string;
		order?: "asc" | "desc";
		fromDate?: string;
		toDate?: string;
		accountId?: string;
		platform?: string;
	}) =>
		request<{
			success: boolean;
			total: number;
			page: number;
			limit: number;
			posts: AnalyticsPostResult[];
		}>("/analytics/", {
			query: {
				source: opts.source ?? "postpeer",
				limit: String(opts.limit ?? 100),
				page: String(opts.page ?? 1),
				sortBy: opts.sortBy,
				order: opts.order,
				fromDate: opts.fromDate,
				toDate: opts.toDate,
				accountId: opts.accountId,
				platform: opts.platform,
			},
		}),

	// Response is nested: {success, data:{uploadUrl, publicUrl}} — unwrap .data.
	presignMedia: async (input: { filename: string; mimeType: string }) => {
		const res = await request<{ success: boolean; data: PresignResponse }>(
			"/media/upload",
			{ method: "POST", body: JSON.stringify(input) },
		);
		return res.data;
	},
};

/** Extracts the integration array from the {success, integrations} envelope. */
export function asIntegrationArray(
	res: Awaited<ReturnType<typeof postpeer.listIntegrations>>,
): PostPeerIntegration[] {
	return res.integrations ?? [];
}
