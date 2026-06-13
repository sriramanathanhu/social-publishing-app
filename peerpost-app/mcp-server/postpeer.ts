// Minimal PostPeer client for the MCP server (publish + cancel only).
// Reads metadata (ecosystems, accounts, analytics) come from our own DB.

const BASE_URL = process.env.POSTPEER_BASE_URL ?? "https://api.postpeer.dev/v1";

function key(): string {
	const k = process.env.POSTPEER_API_KEY;
	if (!k) throw new Error("POSTPEER_API_KEY is not set");
	return k;
}

export type PostPlatformInput = { platform: string; accountId: string };

export type CreatePostInput = {
	content: string;
	platforms: PostPlatformInput[];
	publishNow?: boolean;
	scheduledFor?: string;
	timezone?: string;
};

export type CreatePostResult = {
	success: boolean;
	status?: string;
	postId?: string;
	message?: string;
	platforms?: {
		platform: string;
		success: boolean;
		error?: string;
		url?: string;
	}[];
};

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		...init,
		headers: {
			"x-access-key": key(),
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
		cache: "no-store",
	});
	const text = await res.text();
	const body = text ? JSON.parse(text) : null;
	if (!res.ok && res.status >= 400) {
		const msg = body?.message ?? body?.error ?? `PostPeer error ${res.status}`;
		throw new Error(msg);
	}
	return body as T;
}

export const postpeer = {
	createPost: (input: CreatePostInput) =>
		req<CreatePostResult>("/posts/", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	cancelScheduled: (postId: string) =>
		req<unknown>(`/posts/scheduled/${postId}`, { method: "DELETE" }),
};
