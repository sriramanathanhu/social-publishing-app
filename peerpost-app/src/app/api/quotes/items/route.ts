import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { quoteItems } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

/** GET /api/quotes/items — the caller's saved quotes (recent first). */
export const GET = route(async () => {
	const user = await requireUser();
	const rows = await db
		.select()
		.from(quoteItems)
		.where(eq(quoteItems.userId, user.id))
		.orderBy(desc(quoteItems.createdAt))
		.limit(120);
	return Response.json({ items: rows });
});
