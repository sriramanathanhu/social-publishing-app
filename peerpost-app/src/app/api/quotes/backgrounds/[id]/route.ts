import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { quoteBackgrounds } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { deleteR2Object } from "@/lib/r2";
import { assertAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE — remove a background from the library (ADMIN). Drops the R2 object. */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	assertAdmin(user);
	const { id } = await params;

	const row = await db.query.quoteBackgrounds.findFirst({
		where: eq(quoteBackgrounds.id, id),
	});
	if (!row) throw new HttpError(404, "Background not found");
	try {
		await deleteR2Object(row.r2Key);
	} catch {
		// Orphan object is harmless; proceed.
	}
	await db.delete(quoteBackgrounds).where(eq(quoteBackgrounds.id, id));
	return Response.json({ ok: true });
});
