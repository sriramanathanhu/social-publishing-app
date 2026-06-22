import "server-only";

/** Thin client for the dubber sidecar's /quote-card renderer. */

const BASE = process.env.DUBBER_SERVICE_URL ?? "http://127.0.0.1:8800";

function token(): string {
	const t = process.env.DUBBER_SERVICE_TOKEN;
	if (!t) throw new Error("DUBBER_SERVICE_TOKEN is not set");
	return t;
}

export type CardInput = {
	photoUrl: string;
	quote: string;
	overlayUrl?: string;
	panY?: number;
	zoom?: number;
	finalize?: boolean;
};

/** Call the sidecar; returns the raw fetch Response (PNG bytes for preview,
 * JSON {publicUrl} when finalize=true). */
export function renderQuoteCard(input: CardInput): Promise<Response> {
	return fetch(`${BASE}/quote-card`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${token()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			photo_url: input.photoUrl,
			quote: input.quote,
			overlay_url: input.overlayUrl,
			pan_y: input.panY ?? 0.4,
			zoom: input.zoom ?? 1,
			finalize: input.finalize ?? false,
		}),
		signal: AbortSignal.timeout(60_000),
	});
}
