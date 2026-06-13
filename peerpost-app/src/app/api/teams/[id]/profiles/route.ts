import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { postpeer } from "@/lib/postpeer";
import { assertAdmin } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

const createSchema = z.object({
	name: z.string().min(1).max(200),
	description: z.string().max(1000).optional(),
});

/**
 * POST — create an ecosystem (profile) in this team (ADMIN ONLY). Created in
 * PostPeer first, then mirrored locally. Access to it is granted separately by
 * assigning users under Admin → Members.
 */
export const POST = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	assertAdmin(user);
	const { id } = await params;

	const input = createSchema.parse(await request.json());
	const ppProfile = await postpeer.createProfile(input);

	const [profile] = await db
		.insert(profiles)
		.values({
			teamId: id,
			name: input.name,
			description: input.description,
			postpeerProfileId: ppProfile.id,
			createdByUserId: user.id,
		})
		.returning();

	return Response.json({ profile }, { status: 201 });
});
