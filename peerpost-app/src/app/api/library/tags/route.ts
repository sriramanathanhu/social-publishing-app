import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { contentTags } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

const schema = z.object({
	kind: z.string().min(1).max(40),
	itemId: z.string().min(1).max(64),
	tag: z.string().trim().min(1).max(40),
});

/** POST /api/library/tags — add a tag to an item (idempotent). */
export const POST = route(async (req: NextRequest) => {
	const user = await requireUser();
	const { kind, itemId, tag } = schema.parse(await req.json());
	await db
		.insert(contentTags)
		.values({ userId: user.id, kind, itemId, tag })
		.onConflictDoNothing();
	return Response.json({ ok: true });
});

/** DELETE /api/library/tags — remove a tag from an item. */
export const DELETE = route(async (req: NextRequest) => {
	const user = await requireUser();
	const { kind, itemId, tag } = schema.parse(await req.json());
	await db
		.delete(contentTags)
		.where(
			and(
				eq(contentTags.userId, user.id),
				eq(contentTags.kind, kind),
				eq(contentTags.itemId, itemId),
				eq(contentTags.tag, tag),
			),
		);
	return Response.json({ ok: true });
});
