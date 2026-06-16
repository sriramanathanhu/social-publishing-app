import { createHash, randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";

/**
 * Nandi SSO for the MCP OAuth flow. Instead of pasting an API key, the user
 * signs in with Nandi (same as the app); we resolve their PeerPost user and
 * mint an API key behind the scenes that becomes the connector's access_token.
 */

const { users, apiKeys } = schema;
const AUTH = process.env.NEXT_AUTH_URL ?? "";
const CLIENT_ID = process.env.NEXT_AUTH_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.AUTH_CLIENT_SECRET ?? "";

const SSO_KEY_LABEL = "Claude (SSO)";

type NandiResponse = {
	user_id?: string | number;
	email?: string;
	name?: string;
	role?: string;
};

async function nandiPost(
	path: string,
	sessionToken: string,
): Promise<NandiResponse | null> {
	const res = await fetch(`${AUTH}${path}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Cookie: `nandi_session=${sessionToken}`,
		},
		body: JSON.stringify({
			client_id: CLIENT_ID,
			client_secret: CLIENT_SECRET,
		}),
	});
	if (!res.ok) return null;
	return res.json().catch(() => null) as Promise<NandiResponse | null>;
}

/**
 * Resolve a PeerPost user id from a Nandi session token (validate → /auth/me →
 * match by nandiSub, link by email, or JIT-provision). Returns null if invalid.
 */
export async function resolveUserFromSession(
	sessionToken: string,
): Promise<string | null> {
	const session = await nandiPost("/auth/session", sessionToken);
	const sub = session?.user_id != null ? String(session.user_id) : null;
	if (!sub) return null;

	const profile = await nandiPost("/auth/me", sessionToken);
	const email = profile?.email ?? null;
	const name = profile?.name ?? null;

	const existing = await db.query.users.findFirst({
		where: eq(users.nandiSub, sub),
	});
	if (existing) return existing.id;

	if (email) {
		const byEmail = await db.query.users.findFirst({
			where: eq(users.email, email),
		});
		if (byEmail) {
			await db
				.update(users)
				.set({
					nandiSub: sub,
					name: name ?? byEmail.name,
					lastLoginAt: new Date(),
				})
				.where(eq(users.id, byEmail.id));
			return byEmail.id;
		}
	}

	const [created] = await db
		.insert(users)
		.values({
			nandiSub: sub,
			email,
			name,
			role: profile?.role === "admin" ? "admin" : "user",
			lastLoginAt: new Date(),
		})
		.returning();
	return created.id;
}

/**
 * Mint a fresh API key for the user (the OAuth access_token). One SSO key per
 * user — old ones are revoked so they don't accumulate on each reconnect.
 */
export async function mintApiKey(userId: string): Promise<string> {
	await db
		.delete(apiKeys)
		.where(and(eq(apiKeys.userId, userId), eq(apiKeys.label, SSO_KEY_LABEL)));

	const raw = `pp_${randomBytes(24).toString("base64url")}`;
	const keyHash = createHash("sha256").update(raw).digest("hex");
	await db.insert(apiKeys).values({ userId, label: SSO_KEY_LABEL, keyHash });
	return raw;
}
