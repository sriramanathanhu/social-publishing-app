import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { quoteOverlays } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { deleteR2Object } from "@/lib/r2";
import { assertAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE — remove an overlay from the library (ADMIN). */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	assertAdmin(user);
	const { id } = await params;
	const row = await db.query.quoteOverlays.findFirst({
		where: eq(quoteOverlays.id, id),
	});
	if (!row) throw new HttpError(404, "Overlay not found");
	try {
		await deleteR2Object(row.r2Key);
	} catch {
		// orphan is harmless
	}
	await db.delete(quoteOverlays).where(eq(quoteOverlays.id, id));
	return Response.json({ ok: true });
});
