import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { refreshAnalytics } from "@/lib/analytics";
import { route } from "@/lib/http";
import { assertProfileAccess } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/** POST — refresh cached analytics for one ecosystem (on-demand). */
export const POST = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const updated = await refreshAnalytics([id]);
	return Response.json({ ok: true, updated });
});
