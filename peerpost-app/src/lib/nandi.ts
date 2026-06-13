/**
 * Nandi auth client for auth.kailasa.ai (OAuth2 authorization-code flow).
 *
 * Reverse-engineered to match the working KAILASA app
 * (/root/social-Media-Asset-Management). The public `nandi-auth-examples`
 * repo uses an OLDER/different flow that does NOT work against this server.
 *
 * Flow:
 *   1. /oauth/authorize?client_id&redirect_uri&state   → user signs in
 *   2. callback receives ?auth_code=&state=
 *   3. POST /oauth/exchange-token {code, client_id, client_secret} → {session_token}
 *   4. POST /auth/session (Cookie nandi_session=) {client_id, client_secret} → {user_id}
 *   5. POST /auth/me      (Cookie nandi_session=) {client_id, client_secret} → user
 */

function cfg() {
	const authUrl = process.env.NEXT_AUTH_URL;
	const clientId = process.env.NEXT_AUTH_CLIENT_ID;
	const clientSecret = process.env.AUTH_CLIENT_SECRET;
	if (!authUrl || !clientId || !clientSecret) {
		throw new Error(
			"Missing Nandi auth configuration (NEXT_AUTH_URL/CLIENT_ID/SECRET)",
		);
	}
	return { authUrl, clientId, clientSecret };
}

export const SESSION_COOKIE = "nandi_session_token";
export const STATE_COOKIE = "nandi_oauth_state";

/** Builds the /oauth/authorize URL. `state` is a CSRF token we also cookie. */
export function buildAuthorizeUrl(state: string): string {
	const { authUrl, clientId } = cfg();
	const redirectUri = `${process.env.NEXT_BASE_URL}/api/auth/callback`;
	const params = new URLSearchParams({
		client_id: clientId,
		redirect_uri: redirectUri,
		state,
	});
	return `${authUrl}/oauth/authorize?${params.toString()}`;
}

/** Step 3: exchange the auth code for a session token. */
export async function exchangeToken(code: string): Promise<string | null> {
	const { authUrl, clientId, clientSecret } = cfg();
	const res = await fetch(`${authUrl}/oauth/exchange-token`, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			code,
			client_id: clientId,
			client_secret: clientSecret,
		}),
		cache: "no-store",
	});
	if (!res.ok) return null;
	const data = await res.json().catch(() => ({}));
	return data.session_token ?? null;
}

export type NandiUser = {
	id: number | string;
	name?: string;
	email?: string;
	role?: string;
	ecitizen_id?: string;
	image?: string;
};

/** Step 4: validate the session token; returns the stable user_id or null. */
export async function validateSession(
	sessionToken: string,
): Promise<string | null> {
	const { authUrl, clientId, clientSecret } = cfg();
	const res = await fetch(`${authUrl}/auth/session`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `nandi_session=${sessionToken}`,
		},
		body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
		cache: "no-store",
	});
	if (!res.ok) return null;
	const data = await res.json().catch(() => ({}));
	return data.user_id != null ? String(data.user_id) : null;
}

/** Step 5: fetch the full user profile. */
export async function fetchUser(
	sessionToken: string,
): Promise<NandiUser | null> {
	const { authUrl, clientId, clientSecret } = cfg();
	const res = await fetch(`${authUrl}/auth/me`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `nandi_session=${sessionToken}`,
		},
		body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
		cache: "no-store",
	});
	if (!res.ok) return null;
	return (await res.json().catch(() => null)) as NandiUser | null;
}
