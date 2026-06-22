import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
	title: z.string().max(300).optional(),
	content: z.string().max(100_000).optional(),
});

/** PATCH — update one of the caller's articles (edited title/content). */
export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const patch = patchSchema.parse(await req.json());
	const [row] = await db
		.update(articles)
		.set({ ...patch, updatedAt: new Date() })
		.where(and(eq(articles.id, id), eq(articles.userId, user.id)))
		.returning();
	if (!row) throw new HttpError(404, "Article not found");
	return Response.json({ article: row });
});

/** DELETE — remove one of the caller's articles. */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await db
		.delete(articles)
		.where(and(eq(articles.id, id), eq(articles.userId, user.id)));
	return Response.json({ ok: true });
});
