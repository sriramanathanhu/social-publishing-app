import type { NextRequest } from "next/server";
import { getCurrentUser } from "@/lib/auth";
import { refreshAllAnalytics, refreshAnalytics } from "@/lib/analytics";
import { route } from "@/lib/http";
import { getAccessibleProfiles } from "@/lib/queries";

/**
 * POST /api/analytics/refresh
 *
 * Two callers:
 *  - The daily cron: send header `x-cron-secret: $CRON_SECRET` → refreshes ALL
 *    ecosystems (no user session needed).
 *  - A signed-in user (no secret): refreshes every ecosystem they can access.
 */
export const POST = route(async (request: NextRequest) => {
	const secret = process.env.CRON_SECRET;
	const provided = request.headers.get("x-cron-secret");

	if (secret && provided && provided === secret) {
		const updated = await refreshAllAnalytics();
		return Response.json({ ok: true, scope: "all", updated });
	}

	const user = await getCurrentUser();
	if (!user) return Response.json({ error: "Not authenticated" }, { status: 401 });

	const profiles = await getAccessibleProfiles(user);
	const updated = await refreshAnalytics(profiles.map((p) => p.id));
	return Response.json({ ok: true, scope: "accessible", updated });
});
