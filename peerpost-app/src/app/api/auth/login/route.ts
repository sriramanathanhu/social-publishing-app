import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { DEV_AUTH_BYPASS } from "@/lib/auth";
import { buildAuthorizeUrl, STATE_COOKIE } from "@/lib/nandi";

/**
 * Starts the Nandi OAuth flow: generate a `state` (CSRF), stash it in a
 * short-lived cookie, and redirect to /oauth/authorize. The callback verifies
 * the returned state against this cookie.
 *
 * In local-dev bypass mode there is no Nandi flow — go straight to the app.
 */
export async function GET(request: NextRequest) {
	if (DEV_AUTH_BYPASS) {
		return Response.redirect(new URL("/accounts", request.url), 302);
	}

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
