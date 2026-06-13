import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { postsLog } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { postpeer } from "@/lib/postpeer";
import { assertProfileAccess } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/**
 * DELETE /api/posts/:id — cancel a scheduled post.
 * `:id` is our local posts_log id. We verify profile access, cancel it in
 * PostPeer (if it has a postpeer id), and mark it cancelled locally.
 */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;

	const post = await db.query.postsLog.findFirst({ where: eq(postsLog.id, id) });
	if (!post) return Response.json({ error: "Post not found" }, { status: 404 });

	await assertProfileAccess(user, post.profileId);

	if (post.status !== "scheduled") {
		return Response.json({ error: "Only scheduled posts can be cancelled" }, { status: 400 });
	}

	if (post.postpeerPostId) {
		await postpeer.cancelScheduled(post.postpeerPostId);
	}

	await db.update(postsLog).set({ status: "cancelled" }).where(eq(postsLog.id, id));
	return Response.json({ ok: true });
});
