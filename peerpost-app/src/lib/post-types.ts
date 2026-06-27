/**
 * Content-type taxonomy for posts_log, mapping the free-form `source` column
 * (written by each publishing path) to the user-facing content categories used
 * by the Scheduled view's filter. Keep this in sync with every place that writes
 * `source:` into postsLog.
 */

export type PostTypeKey =
	| "short"
	| "dub"
	| "quote"
	| "article"
	| "transcript"
	| "manual";

/** Filter key → the raw `source` values it covers. */
export const POST_TYPE_SOURCES: Record<PostTypeKey, string[]> = {
	short: ["short", "short-auto"],
	dub: ["dub", "dub-auto"],
	quote: ["quote"],
	article: ["article", "article-auto"],
	transcript: ["transcript", "transcript-auto"],
	// Composer / bulk / API posts, plus legacy rows with no source recorded.
	manual: ["composer"],
};

export const POST_TYPE_LABELS: Record<PostTypeKey, string> = {
	short: "Shorts",
	dub: "Dubbed",
	quote: "Quote cards",
	article: "Articles",
	transcript: "Transcripts",
	manual: "Composer",
};

export const POST_TYPE_ORDER: PostTypeKey[] = [
	"short",
	"dub",
	"quote",
	"article",
	"transcript",
	"manual",
];

export function isPostTypeKey(v: string | null | undefined): v is PostTypeKey {
	return !!v && v in POST_TYPE_SOURCES;
}

/** Source values for a type key. `manual` also matches NULL sources (handled
 * separately in the query, since SQL IN () can't match NULL). */
export function sourcesForType(key: PostTypeKey): string[] {
	return POST_TYPE_SOURCES[key];
}

/** Reverse map: a raw source value → its user-facing label (for display). */
export function labelForSource(source: string | null): string {
	if (!source) return "Composer";
	for (const key of POST_TYPE_ORDER) {
		if (POST_TYPE_SOURCES[key].includes(source)) return POST_TYPE_LABELS[key];
	}
	return source;
}

/**
 * Bucket a raw provider error into a stable category for the failure breakdown.
 * Zernio errors carry variable tails (account handles, "wait 19h 9m", platform
 * names), so grouping the raw string fragments the report — normalise first.
 */
export function categorizePostError(error: string | null): string {
	const e = (error ?? "").toLowerCase();
	if (!e) return "Unknown error";
	if (e.includes("do not belong") || e.includes("does not belong"))
		return "Account not owned by user";
	if (e.includes("rate-limited") || e.includes("rate limit"))
		return "Rate-limited by platform";
	if (e.includes("daily post limit") || e.includes("daily limit"))
		return "Daily post limit reached";
	if (e.includes("not enough credits") || e.includes("credit"))
		return "Out of Zernio credits";
	if (e.includes("already scheduled") || e.includes("already publishing"))
		return "Duplicate content";
	if (e.includes("timeout") || e.includes("aborted")) return "Timed out";
	if (e.includes("no longer on zernio") || e.includes("not found"))
		return "Expired / removed on Zernio";
	if (e.includes("token") || e.includes("auth") || e.includes("permission"))
		return "Account auth / permission";
	// Fall back to a trimmed first line of the raw error.
	const firstLine = (error ?? "").split("\n")[0].trim();
	return firstLine.length > 60 ? `${firstLine.slice(0, 57)}…` : firstLine;
}
