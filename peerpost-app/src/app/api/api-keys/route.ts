import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

/** GET — list the current user's API keys (never returns the raw key). */
export const GET = route(async () => {
	const user = await requireUser();
	const keys = await db
		.select({
			id: apiKeys.id,
			label: apiKeys.label,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, user.id))
		.orderBy(desc(apiKeys.createdAt));
	return Response.json({ keys });
});

const createSchema = z.object({ label: z.string().min(1).max(100) });

/**
 * POST — create an API key. The raw key is returned ONCE; only its hash is
 * stored. Use it as the credential when connecting Claude to the MCP server.
 */
export const POST = route(async (request: NextRequest) => {
	const user = await requireUser();
	const { label } = createSchema.parse(await request.json());

	const raw = `pp_${randomBytes(24).toString("base64url")}`;
	const keyHash = createHash("sha256").update(raw).digest("hex");

	const [created] = await db
		.insert(apiKeys)
		.values({ userId: user.id, label, keyHash })
		.returning({ id: apiKeys.id, label: apiKeys.label });

	return Response.json({ key: { ...created, secret: raw } }, { status: 201 });
});

const deleteSchema = z.object({ id: z.string().uuid() });

/** DELETE — revoke one of the user's API keys. */
export const DELETE = route(async (request: NextRequest) => {
	const user = await requireUser();
	const { id } = deleteSchema.parse(await request.json());
	await db
		.delete(apiKeys)
		.where(and(eq(apiKeys.id, id), eq(apiKeys.userId, user.id)));
	return Response.json({ ok: true });
});
