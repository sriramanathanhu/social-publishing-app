import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { buildAuthorizeUrl, STATE_COOKIE } from "@/lib/nandi";

/**
 * Starts the Nandi OAuth flow: generate a `state` (CSRF), stash it in a
 * short-lived cookie, and redirect to /oauth/authorize. The callback verifies
 * the returned state against this cookie.
 */
export async function GET() {
	const state = randomUUID();

	const cookieStore = await cookies();
	cookieStore.set({
		name: STATE_COOKIE,
		value: state,
		httpOnly: true,
		sameSite: "lax",
		path: "/",
		secure: process.env.NODE_ENV === "production",
		maxAge: 60 * 10, // 10 minutes to complete sign-in
	});

	return Response.redirect(buildAuthorizeUrl(state), 302);
}
