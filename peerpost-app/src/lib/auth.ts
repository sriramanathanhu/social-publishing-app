import { eq } from "drizzle-orm";
import { cookies } from "next/headers";
import { db } from "@/db";
import { users } from "@/db/schema";
import { fetchUser, SESSION_COOKIE, validateSession } from "@/lib/nandi";

export { SESSION_COOKIE };

export type AppUser = typeof users.$inferSelect;

/**
 * Local-development auth bypass. When enabled, the app skips Nandi SSO entirely
 * and acts as a single local **admin** user (admins bypass the approval gate and
 * see everything — see lib/rbac.ts).
 *
 * Double-gated: honoured ONLY when DEV_AUTH_BYPASS=true AND NODE_ENV is exactly
 * "development". We require `=== "development"` (not `!== "production"`) so the
 * bypass stays OFF when NODE_ENV is unset/blank — e.g. a misconfigured staging
 * deploy that forgot to set NODE_ENV — not just when it equals "production".
 * `next dev` and our docker-compose set NODE_ENV=development; `next start`
 * (the production path) sets "production". See docker-compose.yml / .env.docker.
 */
export const DEV_AUTH_BYPASS =
	process.env.NODE_ENV === "development" &&
	process.env.DEV_AUTH_BYPASS === "true";

const DEV_USER_SUB = "dev:local-admin";

/** Get (or lazily create) the local-dev admin user. */
async function getOrCreateDevUser(): Promise<AppUser> {
	const existing = await db.query.users.findFirst({
		where: eq(users.nandiSub, DEV_USER_SUB),
	});
	if (existing) return existing;

	const [created] = await db
		.insert(users)
		.values({
			nandiSub: DEV_USER_SUB,
			email: process.env.DEV_AUTH_EMAIL ?? "dev@localhost",
			name: "Local Dev Admin",
			role: "admin",
			approved: true,
			lastLoginAt: new Date(),
		})
		.returning();
	return created;
}

/**
 * Validate the Nandi session and return our local user, provisioning a row on
 * first login (JIT). Returns null when unauthenticated — the single entry point
 * every protected route/server-component should call.
 *
 * The stable identity is Nandi's `user_id` (from POST /auth/session); profile
 * data (name/email) comes from POST /auth/me.
 */
export async function getCurrentUser(): Promise<AppUser | null> {
	// Local dev: short-circuit Nandi and act as the local admin (no cookie needed).
	if (DEV_AUTH_BYPASS) return getOrCreateDevUser();

	const cookieStore = await cookies();
	const token = cookieStore.get(SESSION_COOKIE)?.value;
	if (!token) return null;

	const userId = await validateSession(token);
	if (!userId) return null;

	const profile = await fetchUser(token);
	const email = profile?.email ?? null;
	const name = profile?.name ?? null;
	const image = profile?.image ?? null;
	const ecitizenId = profile?.ecitizen_id ?? null;

	const existing = await db.query.users.findFirst({
		where: eq(users.nandiSub, userId),
	});

	if (existing) {
		// Refresh whatever SSO returned this login (keep prior value if absent).
		const patch = {
			lastLoginAt: new Date(),
			email: email ?? existing.email,
			name: name ?? existing.name,
			image: image ?? existing.image,
			ecitizenId: ecitizenId ?? existing.ecitizenId,
		};
		await db.update(users).set(patch).where(eq(users.id, existing.id));
		return { ...existing, ...patch };
	}

	// Link an admin-pre-registered user (created by email, nandiSub still
	// "pending:") to this real Nandi identity on their first login.
	if (email) {
		const preRegistered = await db.query.users.findFirst({
			where: eq(users.email, email),
		});
		if (preRegistered) {
			const [linked] = await db
				.update(users)
				.set({
					nandiSub: userId,
					name: name ?? preRegistered.name,
					image: image ?? preRegistered.image,
					ecitizenId: ecitizenId ?? preRegistered.ecitizenId,
					lastLoginAt: new Date(),
				})
				.where(eq(users.id, preRegistered.id))
				.returning();
			return linked;
		}
	}

	const [created] = await db
		.insert(users)
		.values({
			nandiSub: userId,
			email,
			name,
			image,
			ecitizenId,
			role: profile?.role === "admin" ? "admin" : "user",
			lastLoginAt: new Date(),
		})
		.returning();

	return created;
}

/** Throwing variant for use inside route handlers. */
export async function requireUser(): Promise<AppUser> {
	const user = await getCurrentUser();
	if (!user) {
		throw new HttpError(401, "Not authenticated");
	}
	return user;
}

/** Lightweight error carrying an HTTP status, mapped to a Response by routes. */
export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}
