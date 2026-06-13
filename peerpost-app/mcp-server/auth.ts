import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, schema } from "./db";

const { apiKeys, ecosystemMembers, profiles, teams, users } = schema;

export type AuthContext = {
	userId: string;
	userName: string | null;
	email: string | null;
	isAdmin: boolean;
	approved: boolean;
	keyLabel: string;
};

/** Validate an API key (Bearer token) → AuthContext, or throw. */
export async function validateApiKey(rawKey: string): Promise<AuthContext> {
	if (!rawKey?.trim()) throw new Error("API key required");
	const keyHash = createHash("sha256").update(rawKey.trim()).digest("hex");

	const row = await db
		.select({ key: apiKeys, user: users })
		.from(apiKeys)
		.innerJoin(users, eq(users.id, apiKeys.userId))
		.where(eq(apiKeys.keyHash, keyHash))
		.limit(1);

	const found = row[0];
	if (!found) throw new Error("Invalid API key");
	if (found.key.expiresAt && found.key.expiresAt < new Date()) {
		throw new Error("API key expired");
	}

	db.update(apiKeys)
		.set({ lastUsedAt: new Date() })
		.where(eq(apiKeys.id, found.key.id))
		.catch(() => {});

	const u = found.user;
	return {
		userId: u.id,
		userName: u.name,
		email: u.email,
		isAdmin: u.role === "admin",
		approved: u.role === "admin" || u.approved,
		keyLabel: found.key.label,
	};
}

// Per-request auth context (HTTP mode sets it per request).
export const authStorage = new AsyncLocalStorage<AuthContext>();
export function getAuth(): AuthContext {
	const ctx = authStorage.getStore();
	if (!ctx) throw new Error("Not authenticated");
	return ctx;
}

export type AccessibleProfile = {
	id: string;
	name: string;
	description: string | null;
	teamName: string | null;
	postpeerProfileId: string;
};

/** Ecosystems (profiles) the auth'd user may act on. */
export async function accessibleProfiles(
	ctx: AuthContext,
): Promise<AccessibleProfile[]> {
	if (ctx.isAdmin) {
		const rows = await db
			.select({ p: profiles, teamName: teams.name })
			.from(profiles)
			.leftJoin(teams, eq(teams.id, profiles.teamId))
			.orderBy(profiles.createdAt);
		return rows.map((r) => ({
			id: r.p.id,
			name: r.p.name,
			description: r.p.description,
			teamName: r.teamName,
			postpeerProfileId: r.p.postpeerProfileId,
		}));
	}
	if (!ctx.approved) return [];
	const rows = await db
		.select({ p: profiles, teamName: teams.name })
		.from(ecosystemMembers)
		.innerJoin(profiles, eq(profiles.id, ecosystemMembers.profileId))
		.leftJoin(teams, eq(teams.id, profiles.teamId))
		.where(eq(ecosystemMembers.userId, ctx.userId))
		.orderBy(profiles.createdAt);
	return rows.map((r) => ({
		id: r.p.id,
		name: r.p.name,
		description: r.p.description,
		teamName: r.teamName,
		postpeerProfileId: r.p.postpeerProfileId,
	}));
}

/** Resolve + authorize a single ecosystem, or throw. */
export async function requireProfile(
	ctx: AuthContext,
	profileId: string,
): Promise<AccessibleProfile> {
	const list = await accessibleProfiles(ctx);
	const p = list.find((x) => x.id === profileId);
	if (!p) throw new Error("Ecosystem not found or not accessible");
	return p;
}

export { and, eq };
