import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userApiKeys } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto";

/**
 * Per-user dubbing API keys. Stored encrypted (see lib/crypto.ts); the
 * plaintext only ever lives in memory during a request. The browser receives
 * masked presence info, never the values.
 */

export type DubKeyName = "deepgram" | "gemini" | "mistral";

const COLUMN: Record<
	DubKeyName,
	"deepgramKeyEnc" | "geminiKeyEnc" | "mistralKeyEnc"
> = {
	deepgram: "deepgramKeyEnc",
	gemini: "geminiKeyEnc",
	mistral: "mistralKeyEnc",
};

export type DecryptedKeys = Partial<Record<DubKeyName, string>>;

/** Decrypt all stored keys for a user (missing/undecryptable → omitted). */
export async function getUserKeys(userId: string): Promise<DecryptedKeys> {
	const row = await db.query.userApiKeys.findFirst({
		where: eq(userApiKeys.userId, userId),
	});
	if (!row) return {};
	const out: DecryptedKeys = {};
	for (const name of Object.keys(COLUMN) as DubKeyName[]) {
		const enc = row[COLUMN[name]];
		if (enc) {
			try {
				out[name] = decryptSecret(enc);
			} catch {
				// Stale ciphertext (e.g. secret rotated) — treat as unset.
			}
		}
	}
	return out;
}

/** Which keys are present, without revealing values (for the settings UI). */
export async function getUserKeyPresence(
	userId: string,
): Promise<Record<DubKeyName, boolean>> {
	const keys = await getUserKeys(userId);
	return {
		deepgram: !!keys.deepgram,
		gemini: !!keys.gemini,
		mistral: !!keys.mistral,
	};
}

/**
 * Upsert one or more keys. An empty string clears that key; an omitted key is
 * left untouched.
 */
export async function saveUserKeys(
	userId: string,
	updates: Partial<Record<DubKeyName, string>>,
): Promise<void> {
	const set: Record<string, string | null | Date> = { updatedAt: new Date() };
	for (const name of Object.keys(updates) as DubKeyName[]) {
		const value = updates[name];
		if (value === undefined) continue;
		set[COLUMN[name]] = value === "" ? null : encryptSecret(value);
	}

	await db
		.insert(userApiKeys)
		.values({ userId, ...set })
		.onConflictDoUpdate({ target: userApiKeys.userId, set });
}
