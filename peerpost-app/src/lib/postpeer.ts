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
	});

	const text = await res.text();
	const body = text ? JSON.parse(text) : null;

	if (!res.ok) {
		const message = body?.message ?? body?.error ?? `PostPeer error ${res.status}`;
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
		request<{ success: boolean; total: number; integrations: PostPeerIntegration[] }>(
			"/connect/integrations",
		),

	disconnectIntegration: (id: string) =>
		request<unknown>(`/connect/integrations/${id}`, { method: "DELETE" }),

	/** Returns {success, ...} envelope; route extracts an id if present. */
	createPost: (input: CreatePostInput) =>
		request<{ success: boolean; post?: PostPeerPost; id?: string }>("/posts/", {
			method: "POST",
			body: JSON.stringify(input),
		}),

	cancelScheduled: (postId: string) =>
		request<unknown>(`/posts/scheduled/${postId}`, { method: "DELETE" }),

	reschedule: (postId: string, scheduledFor: string) =>
		request<unknown>(`/posts/scheduled/${postId}`, {
			method: "PATCH",
			body: JSON.stringify({ scheduledFor }),
		}),

	presignMedia: (input: { filename: string; mimeType: string }) =>
		request<PresignResponse>("/media/upload", {
			method: "POST",
			body: JSON.stringify(input),
		}),
};

/** Extracts the integration array from the {success, integrations} envelope. */
export function asIntegrationArray(
	res: Awaited<ReturnType<typeof postpeer.listIntegrations>>,
): PostPeerIntegration[] {
	return res.integrations ?? [];
}
