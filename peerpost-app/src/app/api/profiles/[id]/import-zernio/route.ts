import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";
import { importZernioProfile } from "@/lib/sync";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

const bodySchema = z.object({ externalProfileId: z.string().min(1) });

/**
 * POST /api/profiles/:id/import-zernio  (admin only)
 *
 * Link a Zernio profile to this ecosystem and import its connected accounts
 * into integrations_cache (provider='zernio'). Re-runnable to refresh.
 */
export const POST = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	assertAdmin(user);
	const { id } = await params;

	const { externalProfileId } = bodySchema.parse(await request.json());

	const profile = await db.query.profiles.findFirst({
		where: eq(profiles.id, id),
	});
	if (!profile) throw new HttpError(404, "Ecosystem not found");

	const imported = await importZernioProfile(
		profile,
		externalProfileId,
		user.id,
	);
	return Response.json({ imported });
});
