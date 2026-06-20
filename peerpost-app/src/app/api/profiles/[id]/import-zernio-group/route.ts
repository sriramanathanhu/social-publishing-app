import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";
import { importZernioGroup } from "@/lib/sync";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ groupId: z.string().min(1) });

/**
 * POST /api/profiles/:id/import-zernio-group  (admin only)
 *
 * Import a Zernio account group's accounts into this ecosystem. Each account
 * keeps its own Zernio profile id, so a group spanning profiles publishes
 * correctly. Re-runnable; upsert only.
 */
export const POST = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	assertAdmin(user);
	const { id } = await params;

	const { groupId } = bodySchema.parse(await request.json());

	const profile = await db.query.profiles.findFirst({
		where: eq(profiles.id, id),
	});
	if (!profile) throw new HttpError(404, "Ecosystem not found");

	const imported = await importZernioGroup(profile, groupId, user.id);
	return Response.json({ imported });
});
