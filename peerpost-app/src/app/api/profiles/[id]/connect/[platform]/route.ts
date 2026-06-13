import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { PLATFORMS, type Platform, postpeer } from "@/lib/postpeer";
import { assertProfileAccess } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string; platform: string }> };

/**
 * GET /api/profiles/:id/connect/:platform  (req #5)
 *
 * Editor+ on the profile. Asks PostPeer for the hosted OAuth URL, binding the
 * resulting integration to this profile via `profileId`, and returns it so the
 * browser can redirect the user out to the platform.
 *
 * PostPeer captures and stores the social tokens; we never see them. After the
 * user authorises, the platform redirects back to our connect callback, which
 * re-syncs integrations into integrations_cache.
 */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id, platform } = await params;

	if (!PLATFORMS.includes(platform as Platform)) {
		return Response.json({ error: "Unsupported platform" }, { status: 400 });
	}

	const profile = await assertProfileAccess(user, id);

	const redirectUri = `${process.env.NEXT_BASE_URL}/api/connect/callback?profileId=${id}`;

	const { url } = await postpeer.getConnectUrl(platform as Platform, {
		profileId: profile.postpeerProfileId,
		redirectUri,
	});

	// Return the URL (caller redirects). Use ?redirect=1 to 302 directly.
	if (_req.nextUrl.searchParams.get("redirect") === "1") {
		return Response.redirect(url, 302);
	}
	return Response.json({ url });
});
