import { HttpError } from "@/lib/auth";
import type {
	ProviderCreatePost,
	ProviderPostResult,
	PublishProvider,
} from "@/lib/providers/types";

/**
 * Server-side client for the Zernio API (https://zernio.com/api/v1).
 *
 * Auth is a single platform-wide Bearer key (ZERNIO_API_KEY), like PostPeer's
 * key — it lives only on the server. Tenant isolation is our own RBAC layer.
 * Shapes verified against the live API (2026-06-17); the public docs differ in
 * places (e.g. GET /user 404s, profileId comes back as a populated object).
 */

const BASE_URL = process.env.ZERNIO_BASE_URL ?? "https://zernio.com/api/v1";

function apiKey(): string {
	const key = process.env.ZERNIO_API_KEY;
	if (!key) throw new Error("ZERNIO_API_KEY is not set");
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
			Authorization: `Bearer ${apiKey()}`,
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
			body?.message ?? body?.error ?? `Zernio error ${res.status}`;
		throw new HttpError(res.status, String(message));
	}
	return body as T;
}

// ── Raw API shapes (partial) ────────────────────────────────────────────────

type ZernioProfileRaw = {
	_id: string;
	name: string;
	description?: string;
	isDefault?: boolean;
};

type ZernioAccountRaw = {
	_id: string;
	platform: string;
	// profileId comes back POPULATED as an object, not a string.
	profileId?: { _id: string; name?: string } | string | null;
	username?: string;
	displayName?: string;
	isActive?: boolean;
	enabled?: boolean;
};

// ── Normalised shapes used by import/sync ───────────────────────────────────

export type ZernioProfile = {
	externalId: string;
	name: string;
	description: string | null;
};

export type ZernioAccount = {
	externalId: string; // _id — the accountId for posting
	platform: string;
	handle: string | null;
	displayName: string | null;
	externalProfileId: string | null;
	isActive: boolean;
};

function profileIdOf(p: ZernioAccountRaw["profileId"]): string | null {
	if (!p) return null;
	return typeof p === "string" ? p : (p._id ?? null);
}

/** List the Zernio profiles in the connected account (our "ecosystems"). */
export async function listZernioProfiles(): Promise<ZernioProfile[]> {
	const res = await request<{ profiles: ZernioProfileRaw[] }>("/profiles");
	return (res.profiles ?? []).map((p) => ({
		externalId: p._id,
		name: p.name,
		description: p.description ?? null,
	}));
}

/** List connected accounts, optionally scoped to one Zernio profile. */
export async function listZernioAccounts(
	externalProfileId?: string,
): Promise<ZernioAccount[]> {
	const res = await request<{ accounts: ZernioAccountRaw[] }>("/accounts", {
		query: { profileId: externalProfileId },
	});
	return (res.accounts ?? []).map((a) => ({
		externalId: a._id,
		platform: a.platform,
		handle: a.username ?? null,
		displayName: a.displayName ?? null,
		externalProfileId: profileIdOf(a.profileId),
		isActive: a.isActive ?? a.enabled ?? true,
	}));
}

type ZernioGroupRaw = { _id: string; name: string; accountIds?: string[] };
export type ZernioGroup = {
	externalId: string;
	name: string;
	accountIds: string[];
};

/** List Zernio account groups (named bags of account ids; can span profiles). */
export async function listZernioGroups(): Promise<ZernioGroup[]> {
	const res = await request<{ groups: ZernioGroupRaw[] }>("/account-groups");
	return (res.groups ?? []).map((g) => ({
		externalId: g._id,
		name: g.name,
		accountIds: g.accountIds ?? [],
	}));
}

/** Hosted OAuth URL to connect a new account under a Zernio profile. */
export async function zernioConnectUrl(
	platform: string,
	externalProfileId: string,
	redirectUrl?: string,
): Promise<string> {
	const res = await request<{ authUrl: string }>(`/connect/${platform}`, {
		query: { profileId: externalProfileId, redirect_url: redirectUrl },
	});
	return res.authUrl;
}

// ── Publish provider implementation ─────────────────────────────────────────

export const zernioProvider: PublishProvider = {
	name: "zernio",

	async createPost(input: ProviderCreatePost): Promise<ProviderPostResult> {
		const body = {
			content: input.content,
			publishNow: input.publishNow ?? false,
			scheduledFor: input.scheduledFor,
			timezone: input.timezone,
			profileId: input.profileExternalId,
			mediaItems: input.mediaItems,
			platforms: input.platforms.map((p) => ({
				platform: p.platform,
				accountId: p.accountId,
				customContent: p.content,
				platformSpecificData: p.platformSpecificData,
			})),
		};
		const res = await request<{
			post?: { _id?: string; status?: string };
			_id?: string;
			postId?: string;
			status?: string;
			success?: boolean;
			platforms?: {
				platform: string;
				success?: boolean;
				status?: string;
				error?: string;
				url?: string;
			}[];
		}>("/posts", { method: "POST", body: JSON.stringify(body) });

		const postId = res.post?._id ?? res._id ?? res.postId ?? null;
		const status = res.post?.status ?? res.status;
		const platforms = (res.platforms ?? []).map((p) => ({
			platform: p.platform,
			success: p.success ?? p.status !== "failed",
			error: p.error,
			url: p.url,
		}));
		// A 2xx with a post id means Zernio accepted it. Per-platform failures (if
		// reported) are surfaced but don't, by themselves, fail the whole call.
		const success = res.success ?? (postId !== null && status !== "failed");
		return { success, postId, status, message: undefined, platforms };
	},

	async cancelScheduled(postId: string): Promise<void> {
		await request<unknown>(`/posts/${postId}`, { method: "DELETE" });
	},

	/** Fetch the live published link for one account from GET /posts/:id. The
	 * platform entry carries `platformPostUrl` once it has finished publishing
	 * (accountId there is a populated object, so match on its _id). */
	async getPublishedUrl(
		postId: string,
		accountId: string,
	): Promise<string | null> {
		type PlatformEntry = {
			platform?: string;
			accountId?: string | { _id?: string };
			platformPostUrl?: string;
			status?: string;
		};
		const res = await request<{
			post?: { platforms?: PlatformEntry[] };
			platforms?: PlatformEntry[];
		}>(`/posts/${postId}`, { method: "GET" });
		const platforms = res.post?.platforms ?? res.platforms ?? [];
		const idOf = (a: PlatformEntry["accountId"]) =>
			typeof a === "string" ? a : (a?._id ?? "");
		const match =
			platforms.find((p) => idOf(p.accountId) === accountId) ??
			(platforms.length === 1 ? platforms[0] : undefined);
		return match?.platformPostUrl || null;
	},
};

/** Full status of a post from GET /posts/:id, normalised for our reconcile.
 * Returns null when Zernio no longer has the post (404 — e.g. it expired or was
 * deleted there). The post-level `status` is one of
 * published | failed | publishing | scheduled | partial. Standalone (not on the
 * PublishProvider interface) since only our own reconcile uses it. */
export async function getZernioPostStatus(
	postId: string,
): Promise<ZernioPostStatus | null> {
	let res: { post?: ZernioRawPost } & ZernioRawPost;
	try {
		res = await request(`/posts/${postId}`, { method: "GET" });
	} catch (err) {
		if (err instanceof HttpError && err.status === 404) return null;
		throw err;
	}
	const p = res.post ?? res;
	const platforms = (p.platforms ?? []).map((x) => ({
		platform: x.platform ?? "",
		status: x.status ?? null,
		url: x.platformPostUrl || null,
		error: x.error || x.errorMessage || null,
	}));
	return {
		status: p.status ?? null,
		platforms,
		error: p.error || platforms.find((x) => x.error)?.error || null,
	};
}

type ZernioRawPost = {
	status?: string;
	error?: string;
	platforms?: {
		platform?: string;
		status?: string;
		platformPostUrl?: string;
		error?: string;
		errorMessage?: string;
	}[];
};

export type ZernioPostStatus = {
	status: string | null;
	platforms: {
		platform: string;
		status: string | null;
		url: string | null;
		error: string | null;
	}[];
	error: string | null;
};
