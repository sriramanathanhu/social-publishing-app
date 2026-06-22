import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { quoteItems } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
	text: z.string().min(1).max(2000).optional(),
	hashtags: z.array(z.string()).max(8).optional(),
	bgUrl: z.string().url().nullable().optional(),
	overlayUrl: z.string().url().nullable().optional(),
	cardUrl: z.string().url().nullable().optional(),
	panY: z.number().min(0).max(1).optional(),
	zoom: z.number().min(1).max(3).optional(),
});

/** PATCH — update one of the caller's saved quotes (text / card composition). */
export const PATCH = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const patch = patchSchema.parse(await req.json());
	const [row] = await db
		.update(quoteItems)
		.set({ ...patch, updatedAt: new Date() })
		.where(and(eq(quoteItems.id, id), eq(quoteItems.userId, user.id)))
		.returning();
	if (!row) throw new HttpError(404, "Quote not found");
	return Response.json({ item: row });
});

/** DELETE — remove one of the caller's saved quotes. */
export const DELETE = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await db
		.delete(quoteItems)
		.where(and(eq(quoteItems.id, id), eq(quoteItems.userId, user.id)));
	return Response.json({ ok: true });
});
