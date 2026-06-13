import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { getCurrentUser } from "@/lib/auth";
import { syncProfileIntegrations } from "@/lib/sync";

/**
 * OAuth return URL. After the user authorises on the platform, PostPeer
 * redirects here (with ?profileId=). We re-sync this profile's integrations
 * from PostPeer, then bounce the user back to the profile page.
 */
export async function GET(request: NextRequest) {
	const localProfileId = request.nextUrl.searchParams.get("profileId");
	const user = await getCurrentUser();
	const base = process.env.NEXT_BASE_URL ?? new URL(request.url).origin;

	if (!user || !localProfileId) {
		return Response.redirect(`${base}/accounts`, 302);
	}

	const profile = await db.query.profiles.findFirst({
		where: eq(profiles.id, localProfileId),
	});
	if (!profile) {
		return Response.redirect(`${base}/accounts`, 302);
	}

	try {
		await syncProfileIntegrations(profile, user.id);
	} catch (err) {
		console.error("connect/callback sync error:", err);
	}

	return Response.redirect(
		`${base}/accounts/${localProfileId}?connected=1`,
		302,
	);
}
