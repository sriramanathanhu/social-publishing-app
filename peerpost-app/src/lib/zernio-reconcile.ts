import { and, asc, eq, isNotNull, lte, ne, sql } from "drizzle-orm";
import { db } from "@/db";
import { postsLog } from "@/db/schema";
import {
	getZernioPostStatus,
	type ZernioPostStatus,
} from "@/lib/providers/zernio";

/**
 * Reconciling our `posts_log` against Zernio's truth. We hand a post to Zernio
 * with a scheduled time and then never hear back (no webhook historically), so a
 * submitted post stays "scheduled" in our DB forever even after Zernio publishes
 * or fails it. These helpers pull the real outcome — used by both the webhook
 * receiver (real-time) and the batch backfill (one-off + safety-net cron).
 */

/** Map a Zernio post-level status to our terminal posts_log status, or null for
 * states that haven't resolved yet (we leave those as "scheduled"). */
export function mapZernioStatus(
	s: string | null,
): "published" | "failed" | null {
	const v = (s ?? "").toLowerCase();
	if (v === "published" || v === "partial" || v === "completed")
		return "published";
	if (v === "failed" || v === "error" || v === "rejected") return "failed";
	// publishing | pending | scheduled | queued | processing | draft → not terminal
	return null;
}

/** Apply a fetched Zernio status to every posts_log row for that provider post.
 * Returns the terminal status written, or null if nothing changed (non-terminal
 * or no matching row). Never touches rows the user cancelled. */
export async function applyZernioStatus(
	postId: string,
	st: ZernioPostStatus,
): Promise<"published" | "failed" | null> {
	const mapped = mapZernioStatus(st.status);
	if (!mapped) return null;
	const url = st.platforms.find((p) => p.url)?.url ?? null;
	const updated = await db
		.update(postsLog)
		.set({
			status: mapped,
			error: mapped === "failed" ? (st.error ?? "Publishing failed") : null,
			...(url ? { publishedUrl: url } : {}),
		})
		.where(
			and(
				eq(postsLog.postpeerPostId, postId),
				eq(postsLog.provider, "zernio"),
				ne(postsLog.status, "cancelled"),
			),
		)
		.returning({ id: postsLog.id });
	return updated.length > 0 ? mapped : null;
}

/** Mark a submitted post failed because Zernio no longer has it (404 — expired or
 * purged), so it leaves the "scheduled" bucket. The outcome is genuinely unknown
 * for these, so the error says so. */
async function markGone(postId: string): Promise<void> {
	await db
		.update(postsLog)
		.set({
			status: "failed",
			error: "No longer on Zernio (expired or purged) — final status unknown",
		})
		.where(
			and(
				eq(postsLog.postpeerPostId, postId),
				eq(postsLog.provider, "zernio"),
				eq(postsLog.status, "scheduled"),
			),
		);
}

export type ReconcileSummary = {
	checked: number;
	published: number;
	failed: number;
	gone: number;
	pending: number;
	remaining: number;
};

/**
 * Backfill/safety-net: pull the real status of "scheduled" Zernio posts and
 * advance the terminal ones. Processes one batch (oldest scheduled first) with
 * bounded concurrency, so the caller can loop it until `remaining` is 0 without
 * tripping the request timeout. `onlyOverdue` restricts to posts whose scheduled
 * time has passed (the cron safety-net mode — future posts can't have fired yet).
 */
export async function reconcileScheduledZernioPosts(opts: {
	limit?: number;
	concurrency?: number;
	onlyOverdue?: boolean;
}): Promise<ReconcileSummary> {
	const limit = opts.limit ?? 200;
	const concurrency = Math.max(1, Math.min(opts.concurrency ?? 8, 16));

	const conds = [
		eq(postsLog.status, "scheduled"),
		eq(postsLog.provider, "zernio"),
		isNotNull(postsLog.postpeerPostId),
		...(opts.onlyOverdue ? [lte(postsLog.scheduledFor, new Date())] : []),
	];
	const rows = await db
		.select({ id: postsLog.id, pid: postsLog.postpeerPostId })
		.from(postsLog)
		.where(and(...conds))
		.orderBy(asc(postsLog.scheduledFor))
		.limit(limit);

	const summary: ReconcileSummary = {
		checked: 0,
		published: 0,
		failed: 0,
		gone: 0,
		pending: 0,
		remaining: 0,
	};

	// Process in fixed-size waves to cap concurrent Zernio calls.
	for (let i = 0; i < rows.length; i += concurrency) {
		const wave = rows.slice(i, i + concurrency);
		await Promise.all(
			wave.map(async (r) => {
				if (!r.pid) return;
				summary.checked++;
				try {
					const st = await getZernioPostStatus(r.pid);
					if (st === null) {
						await markGone(r.pid);
						summary.gone++;
						return;
					}
					const res = await applyZernioStatus(r.pid, st);
					if (res === "published") summary.published++;
					else if (res === "failed") summary.failed++;
					else summary.pending++;
				} catch {
					// Transient (timeout/5xx) — leave it; the next pass retries.
					summary.pending++;
				}
			}),
		);
	}

	// How many scheduled Zernio posts still remain after this batch.
	const [{ count } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(postsLog)
		.where(and(...conds));
	summary.remaining = Number(count);
	return summary;
}
