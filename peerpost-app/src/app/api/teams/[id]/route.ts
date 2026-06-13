import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { teams } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
	name: z.string().min(1).max(200).optional(),
	description: z.string().max(1000).optional(),
});

/** PATCH — rename / update a team (ADMIN ONLY). */
export const PATCH = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	assertAdmin(user);
	const { id } = await params;

	const input = patchSchema.parse(await request.json());
	const [team] = await db
		.update(teams)
		.set(input)
		.where(eq(teams.id, id))
		.returning();

	return Response.json({ team });
});
