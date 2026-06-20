import { and, eq, inArray } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { postsLog } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertProfileAccess } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/profiles/:id/posts/status?ids=a,b,c
 *
 * Statuses of the given posts_log rows (scoped to this profile) — the publish
 * UI polls this while background publishing resolves each account.
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
		})
		.from(postsLog)
		.where(and(eq(postsLog.profileId, id), inArray(postsLog.id, ids)));

	return Response.json({ statuses: rows });
});
