import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { userVideos } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { deleteR2Object } from "@/lib/r2";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE — remove an uploaded video (R2 object + row). */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const row = await db.query.userVideos.findFirst({
		where: and(eq(userVideos.id, id), eq(userVideos.userId, user.id)),
	});
	if (row) {
		await deleteR2Object(row.r2Key).catch(() => {});
		await db.delete(userVideos).where(eq(userVideos.id, id));
	}
	return Response.json({ ok: true });
});
