import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { listZernioGroups } from "@/lib/providers/zernio";
import { assertAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

/**
 * GET /api/admin/zernio/groups — Zernio account groups available to import
 * (admin only). Used by the "Link Zernio group" control on an ecosystem.
 */
export const GET = route(async () => {
	const user = await requireUser();
	assertAdmin(user);
	const groups = await listZernioGroups();
	return Response.json({
		groups: groups.map((g) => ({
			externalId: g.externalId,
			name: g.name,
			count: g.accountIds.length,
		})),
	});
});
