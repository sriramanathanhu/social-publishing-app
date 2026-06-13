import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { teams } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { getTeamsForUser } from "@/lib/queries";
import { assertAdmin } from "@/lib/rbac";

/** GET — teams the user can access (all teams for admins). */
export const GET = route(async () => {
	const user = await requireUser();
	return Response.json({ teams: await getTeamsForUser(user) });
});

const createSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
});

/** POST — create a team (ADMIN ONLY). Teams are admin-managed containers. */
export const POST = route(async (request: NextRequest) => {
	const user = await requireUser();
	assertAdmin(user);

	const input = createSchema.parse(await request.json());

	const [team] = await db
		.insert(teams)
		.values({ ...input, createdByUserId: user.id })
		.returning();

	return Response.json({ team }, { status: 201 });
});
