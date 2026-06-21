import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { postsLog } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getProvider } from "@/lib/providers";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/profiles/:id/posts/status?ids=a,b,c
 *
 * Statuses of the given posts_log rows (scoped to this profile) — the publish
 * UI polls this while background publishing resolves each account. For rows that
 * have finished publishing but don't yet have a public link, we fetch it from
 * the provider once (publishing is async, so the link appears a beat later) and
 * cache it on the row, then return it so the UI can show "View post".
 */
export const GET = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const ids = (req.nextUrl.searchParams.get("ids") ?? "")
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (ids.length === 0) return Response.json({ statuses: [] });

	const rows = await db
		.select({
			id: postsLog.id,
			status: postsLog.status,
			error: postsLog.error,
			provider: postsLog.provider,
			postId: postsLog.postpeerPostId,
			publishedUrl: postsLog.publishedUrl,
			platforms: postsLog.platforms,
		})
		.from(postsLog)
		.where(and(eq(postsLog.profileId, id), inArray(postsLog.id, ids)));

	// Backfill the public link for freshly-published rows that don't have one.
	const enriched = await Promise.all(
		rows.map(async (r) => {
			let url = r.publishedUrl;
			if (!url && r.status === "published" && r.postId) {
				const accountId = r.platforms?.[0]?.accountId;
				const provider = getProvider(r.provider);
				if (accountId && provider.getPublishedUrl) {
					try {
						url = await provider.getPublishedUrl(r.postId, accountId);
						if (url) {
							await db
								.update(postsLog)
								.set({ publishedUrl: url })
								.where(eq(postsLog.id, r.id));
						}
					} catch {
						// Link not ready yet / fetch failed — try again next poll.
					}
				}
			}
			return { id: r.id, status: r.status, error: r.error, url };
		}),
	);

	return Response.json({ statuses: enriched });
});
