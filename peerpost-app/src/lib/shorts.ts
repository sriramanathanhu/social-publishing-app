import { HttpError } from "@/lib/auth";

/**
 * Server-side client for the Shorts pipeline in the dubber-service sidecar.
 * Same bearer-token auth and SSE-proxy pattern as lib/dubber.ts. User API keys
 * (Deepgram, NVIDIA) are passed per-job and never persisted by the service.
 */

const BASE_URL = process.env.DUBBER_SERVICE_URL ?? "http://127.0.0.1:8800";

function token(): string {
	const t = process.env.DUBBER_SERVICE_TOKEN;
	if (!t) throw new Error("DUBBER_SERVICE_TOKEN is not set");
	return t;
}

function authHeaders(): Record<string, string> {
	return { Authorization: `Bearer ${token()}` };
}

export type ShortsCreateInput = {
	video_input: string;
	deepgram_key: string;
	nvidia_key: string;
	source_type?: "url" | "upload";
	cookies?: string;
	num_clips?: number;
	min_seconds?: number;
	max_seconds?: number;
	aspect?: string;
	crop_focus?: "center" | "left" | "right";
	language?: string;
	captions?: boolean;
	selector?: "gemini" | "nim";
	gemini_key?: string;
	media_resolution?: string;
	overlay_url?: string;
	transition_url?: string;
	endcard_url?: string;
	settings?: Record<string, unknown>;
};

export type ShortsStatus = {
	job_id: string;
	status: "queued" | "running" | "done" | "failed";
	pct: number;
	stage: string;
	message: string;
	error: string | null;
	count: number;
};

export type ShortsClip = {
	idx: number;
	title?: string;
	youtube_title?: string;
	youtube_description?: string;
	hashtags?: string[];
	start_seconds?: number;
	end_seconds?: number;
	duration?: number;
	viral_score?: number;
	r2_key?: string;
	public_url?: string | null;
};

async function json<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = text ? JSON.parse(text) : null;
	if (!res.ok) {
		const message = body?.error ?? body?.detail ?? `Shorts error ${res.status}`;
		throw new HttpError(res.status === 401 ? 502 : res.status, String(message));
	}
	return body as T;
}

export const shorts = {
	createJob: async (input: ShortsCreateInput): Promise<{ job_id: string }> => {
		const res = await fetch(`${BASE_URL}/shorts`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify(input),
			cache: "no-store",
		});
		return json<{ job_id: string; status: string }>(res);
	},

	getStatus: async (jobId: string): Promise<ShortsStatus> => {
		const res = await fetch(`${BASE_URL}/shorts/${jobId}`, {
			headers: authHeaders(),
			cache: "no-store",
		});
		return json<ShortsStatus>(res);
	},

	getClips: async (jobId: string): Promise<ShortsClip[]> => {
		const res = await fetch(`${BASE_URL}/shorts/${jobId}/clips`, {
			headers: authHeaders(),
			cache: "no-store",
		});
		const body = await json<{ clips: ShortsClip[] }>(res);
		return body.clips ?? [];
	},

	eventStream: (jobId: string): Promise<Response> =>
		fetch(`${BASE_URL}/shorts/${jobId}/events`, { headers: authHeaders() }),
};
