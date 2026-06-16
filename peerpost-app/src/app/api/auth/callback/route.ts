import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { exchangeToken, SESSION_COOKIE, STATE_COOKIE } from "@/lib/nandi";

/**
 * Nandi redirects here as ?auth_code=XXX&state=YYY after sign-in (or ?error=).
 * We verify state (CSRF), exchange the code for a session token, store it in an
 * httpOnly cookie, and bounce to /accounts. Matches the working KAILASA flow.
 */
export async function GET(request: NextRequest) {
	const base = process.env.NEXT_BASE_URL ?? new URL(request.url).origin;
	const params = request.nextUrl.searchParams;
	const authCode = params.get("auth_code");
	const returnedState = params.get("state");
	const nandiError = params.get("error");

	const fail = (code: string) =>
		Response.redirect(`${base}/?error=${encodeURIComponent(code)}`, 302);

	try {
		if (nandiError) {
			console.error("Nandi auth error:", nandiError);
			return fail("auth_failed");
		}
		if (!authCode) return fail("missing_auth_code");

		// CSRF: returned state must match the cookie we set at /api/auth/login.
		const cookieStore = await cookies();
		const expectedState = cookieStore.get(STATE_COOKIE)?.value;
		if (!expectedState || expectedState !== returnedState) {
			return fail("state_mismatch");
		}
		cookieStore.delete(STATE_COOKIE);

		const sessionToken = await exchangeToken(authCode);
		if (!sessionToken) return fail("token_exchange_failed");

		cookieStore.set({
			name: SESSION_COOKIE,
			value: sessionToken,
			httpOnly: true,
			sameSite: "lax", // lax (not strict) so the cross-site redirect keeps the cookie
			path: "/",
			secure: process.env.NODE_ENV === "production",
			maxAge: 60 * 60 * 24 * 7, // 7 days
		});

		// MCP connector login: hand back to the MCP server to mint its token.
		if (returnedState?.startsWith("mcp:")) {
			const login = returnedState.slice(4);
			return Response.redirect(`${base}/oauth/mcp-finish?login=${login}`, 302);
		}

		return Response.redirect(`${base}/accounts`, 302);
	} catch (error) {
		console.error("auth/callback error:", error);
		return fail("callback_error");
	}
}
