import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { ecosystemMembers, users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

const putSchema = z.object({ profileIds: z.array(z.string().uuid()) });

/**
 * PUT /api/users/:id/ecosystems — set the full list of ecosystems assigned to a
 * user (ADMIN ONLY). Ecosystems may only be assigned to APPROVED users.
 */
export const PUT = route(async (request: NextRequest, { params }: Ctx) => {
	const admin = await requireUser();
	assertAdmin(admin);
	const { id } = await params;

	const { profileIds } = putSchema.parse(await request.json());

	const target = await db.query.users.findFirst({ where: eq(users.id, id) });
	if (!target)
		return Response.json({ error: "User not found" }, { status: 404 });

	if (profileIds.length > 0 && !target.approved && target.role !== "admin") {
		return Response.json(
			{ error: "Approve the user before assigning ecosystems" },
			{ status: 400 },
		);
	}

	// Replace the user's assignments with the provided set.
	await db.delete(ecosystemMembers).where(eq(ecosystemMembers.userId, id));
	if (profileIds.length > 0) {
		await db
			.insert(ecosystemMembers)
			.values(profileIds.map((profileId) => ({ profileId, userId: id })));
	}

	return Response.json({ ok: true, count: profileIds.length });
});
