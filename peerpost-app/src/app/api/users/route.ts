import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { users } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";

const createSchema = z.object({
	email: z.string().email(),
	name: z.string().max(200).optional(),
	role: z.enum(["admin", "user"]).default("user"),
});

/**
 * POST /api/users — pre-register a user (ADMIN ONLY).
 *
 * Identity ultimately comes from Nandi SSO, so we can't create a real login.
 * Instead we create a placeholder row keyed on email with a "pending:" sub.
 * On that person's first Nandi login, getCurrentUser links it to their real
 * Nandi id (see lib/auth.ts). This lets admins assign users to teams up front.
 */
export const POST = route(async (request: NextRequest) => {
	const admin = await requireUser();
	assertAdmin(admin);

	const { email, name, role } = createSchema.parse(await request.json());

	const existing = await db.query.users.findFirst({
		where: eq(users.email, email),
	});
	if (existing) {
		return Response.json(
			{ error: "A user with that email already exists" },
			{ status: 409 },
		);
	}

	const [created] = await db
		.insert(users)
		.values({ nandiSub: `pending:${email}`, email, name: name ?? null, role })
		.returning();

	return Response.json({ user: created }, { status: 201 });
});
