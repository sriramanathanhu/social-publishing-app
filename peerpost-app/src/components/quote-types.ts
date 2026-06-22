export type QuoteBackground = { id: string; url: string; label: string | null };
export type QuoteOverlay = {
	id: string;
	url: string;
	label: string | null;
	isDefault?: boolean;
};

/** A persisted generated quote (+ its card composition once rendered). */
export type QuoteItem = {
	id: string;
	text: string;
	hashtags: string[];
	bgUrl: string | null;
	overlayUrl: string | null;
	cardUrl: string | null;
	panY: number;
	zoom: number;
};

/** Persist a partial update to a saved quote (best-effort). */
export async function patchQuoteItem(
	id: string,
	patch: Partial<Omit<QuoteItem, "id">>,
): Promise<void> {
	try {
		await fetch(`/api/quotes/items/${id}`, {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(patch),
		});
	} catch {
		// best-effort; the in-memory state stays correct for this session
	}
}
