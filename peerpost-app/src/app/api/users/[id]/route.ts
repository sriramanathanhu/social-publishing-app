import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

const patchSchema = z.object({
	role: z.enum(["admin", "user"]).optional(),
	approved: z.boolean().optional(),
});

/** PATCH /api/users/:id — change access level and/or approval (ADMIN ONLY). */
export const PATCH = route(async (request: NextRequest, { params }: Ctx) => {
	const admin = await requireUser();
	assertAdmin(admin);
	const { id } = await params;

	const input = patchSchema.parse(await request.json());

	// Don't let an admin lock themselves out.
	if (id === admin.id && input.role && input.role !== "admin") {
		return Response.json(
			{ error: "You cannot change your own admin role" },
			{ status: 400 },
		);
	}

	const [updated] = await db
		.update(users)
		.set(input)
		.where(eq(users.id, id))
		.returning();

	return Response.json({ user: updated });
});
