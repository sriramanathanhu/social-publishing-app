import {
	createCipheriv,
	createDecipheriv,
	randomBytes,
	scryptSync,
} from "node:crypto";

/**
 * AES-256-GCM encryption for user API keys at rest.
 *
 * Keys are encrypted with a server-side secret (KEY_ENCRYPTION_SECRET) before
 * being written to the DB and decrypted only at job-dispatch time. The secret
 * must be set in the environment and kept out of the repo; rotating it
 * invalidates all stored ciphertext (users re-enter their keys).
 *
 * Wire format (base64): [12-byte IV][16-byte auth tag][ciphertext].
 */

const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

function key(): Buffer {
	if (cachedKey) return cachedKey;
	const secret = process.env.KEY_ENCRYPTION_SECRET;
	if (!secret || secret.length < 16) {
		throw new Error(
			"KEY_ENCRYPTION_SECRET is not set (or too short, need ≥16 chars)",
		);
	}
	// Deterministic 32-byte key derived from the secret. Fixed salt is fine here:
	// the secret is the protected material, and per-value IVs provide uniqueness.
	cachedKey = scryptSync(secret, "peerpost-api-keys-v1", 32);
	return cachedKey;
}

export function encryptSecret(plaintext: string): string {
	const iv = randomBytes(IV_BYTES);
	const cipher = createCipheriv("aes-256-gcm", key(), iv);
	const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decryptSecret(payload: string): string {
	const raw = Buffer.from(payload, "base64");
	const iv = raw.subarray(0, IV_BYTES);
	const tag = raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
	const enc = raw.subarray(IV_BYTES + TAG_BYTES);
	const decipher = createDecipheriv("aes-256-gcm", key(), iv);
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(enc), decipher.final()]).toString(
		"utf8",
	);
}

/** Mask a key for display: keeps the last 4 chars. */
export function maskSecret(plaintext: string): string {
	if (plaintext.length <= 4) return "••••";
	return `••••${plaintext.slice(-4)}`;
}
