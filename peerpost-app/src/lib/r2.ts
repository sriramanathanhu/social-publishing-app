import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";

/**
 * Cloudflare R2 (S3-compatible) client for durably archiving finished dubs.
 *
 * Archive-only: we never serve these objects publicly — publishing still goes
 * through PostPeer's media flow. This is a backup so a finished dub survives a
 * sidecar restart / local-disk cleanup. Credentials live in the app env
 * (R2_ENDPOINT/R2_BUCKET/R2_ACCESS_KEY_ID/R2_SECRET_ACCESS_KEY), gitignored.
 */

let cached: { client: S3Client; bucket: string } | null = null;

function r2(): { client: S3Client; bucket: string } | null {
	if (cached) return cached;
	const endpoint = process.env.R2_ENDPOINT;
	const bucket = process.env.R2_BUCKET;
	const accessKeyId = process.env.R2_ACCESS_KEY_ID;
	const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
	if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) return null;
	cached = {
		bucket,
		// R2 ignores region but the SDK requires one — "auto" is the convention.
		client: new S3Client({
			region: "auto",
			endpoint,
			credentials: { accessKeyId, secretAccessKey },
		}),
	};
	return cached;
}

/** Whether R2 archiving is configured (all env vars present). */
export const r2Enabled = (): boolean => r2() !== null;

/**
 * Public URL for an R2 object via the bucket's custom domain
 * (R2_PUBLIC_BASE_URL, e.g. https://socialmedia.kailasa.ai). Returns null if the
 * domain isn't configured. Used to serve/publish archived dubs without a
 * separate upload.
 */
export function r2PublicUrl(key: string | null | undefined): string | null {
	if (!key) return null;
	let base = (process.env.R2_PUBLIC_BASE_URL ?? "").trim().replace(/\/$/, "");
	if (!base) return null;
	if (!/^https?:\/\//.test(base)) base = `https://${base}`;
	return `${base}/${key}`;
}

/**
 * Upload a finished dub to R2 under `dubs/<jobId>.mp4` and return the object
 * key. Returns null if R2 is not configured. Throws on a genuine upload error
 * so callers can keep it best-effort.
 */
export async function archiveDubVideo(
	jobId: string,
	bytes: ArrayBuffer,
): Promise<string | null> {
	const r = r2();
	if (!r) return null;
	const key = `dubs/${jobId}.mp4`;
	await r.client.send(
		new PutObjectCommand({
			Bucket: r.bucket,
			Key: key,
			Body: new Uint8Array(bytes),
			ContentType: "video/mp4",
		}),
	);
	return key;
}
