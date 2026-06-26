import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { quoteDistributions } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** DELETE /api/quotes/distributions/:id — remove one of the user's lists. */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await db
		.delete(quoteDistributions)
		.where(
			and(
				eq(quoteDistributions.id, id),
				eq(quoteDistributions.userId, user.id),
			),
		);
	return Response.json({ ok: true });
});
