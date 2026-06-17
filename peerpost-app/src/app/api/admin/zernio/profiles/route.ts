import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { listZernioProfiles } from "@/lib/providers/zernio";
import { assertAdmin } from "@/lib/rbac";

export const runtime = "nodejs";

/**
 * GET /api/admin/zernio/profiles — list the Zernio profiles available to import
 * (admin only). Used by the "Link Zernio profile" control when wiring an
 * ecosystem to Zernio.
 */
export const GET = route(async () => {
	const user = await requireUser();
	assertAdmin(user);
	const profiles = await listZernioProfiles();
	return Response.json({ profiles });
});
