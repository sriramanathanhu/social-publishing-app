import { HttpError } from "@/lib/auth";

/**
 * Server-side client for the dubber-service sidecar (../dubber-service).
 *
 * The service runs the Python dubbing pipeline. We authenticate with a shared
 * bearer token (DUBBER_SERVICE_TOKEN) — the service is internal and never
 * exposed to the browser. User API keys are passed per-job and are never
 * persisted by the service.
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

export type DubberCreateInput = {
	video_input: string;
	target_lang: string;
	voice: string;
	deepgram_key: string;
	gemini_key?: string;
	nvidia_key?: string;
	platforms?: string[];
	source_lang?: string;
	source_type?: "url" | "upload";
	cookies?: string;
};

export type DubberCaption = { caption: string; title?: string };

export type DubberStatus = {
	job_id: string;
	status: "queued" | "running" | "done" | "failed";
	pct: number;
	stage: string;
	message: string;
	error: string | null;
	has_output: boolean;
};

async function json<T>(res: Response): Promise<T> {
	const text = await res.text();
	const body = text ? JSON.parse(text) : null;
	if (!res.ok) {
		const message = body?.error ?? body?.detail ?? `Dubber error ${res.status}`;
		throw new HttpError(res.status === 401 ? 502 : res.status, String(message));
	}
	return body as T;
}

export const dubber = {
	createJob: async (input: DubberCreateInput): Promise<{ job_id: string }> => {
		const res = await fetch(`${BASE_URL}/jobs`, {
			method: "POST",
			headers: { ...authHeaders(), "Content-Type": "application/json" },
			body: JSON.stringify(input),
			cache: "no-store",
		});
		return json<{ job_id: string; status: string }>(res);
	},

	getStatus: async (dubberJobId: string): Promise<DubberStatus> => {
		const res = await fetch(`${BASE_URL}/jobs/${dubberJobId}`, {
			headers: authHeaders(),
			cache: "no-store",
		});
		return json<DubberStatus>(res);
	},

	/** AI-generated per-platform captions (available once the job is done). */
	getCaptions: async (
		dubberJobId: string,
	): Promise<Record<string, DubberCaption>> => {
		const res = await fetch(`${BASE_URL}/jobs/${dubberJobId}/captions`, {
			headers: authHeaders(),
			cache: "no-store",
		});
		const body = await json<{ captions: Record<string, DubberCaption> }>(res);
		return body.captions ?? {};
	},

	/** Raw SSE stream from the service, to proxy straight to the browser. */
	eventStream: (dubberJobId: string): Promise<Response> =>
		fetch(`${BASE_URL}/jobs/${dubberJobId}/events`, {
			headers: authHeaders(),
			cache: "no-store",
		}),

	/** The finished mp4 as a fetch Response (body is the video bytes). */
	result: (dubberJobId: string): Promise<Response> =>
		fetch(`${BASE_URL}/jobs/${dubberJobId}/result`, {
			headers: authHeaders(),
			cache: "no-store",
		}),
};
