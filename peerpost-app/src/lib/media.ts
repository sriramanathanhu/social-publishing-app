import { HttpError } from "@/lib/auth";
import { postpeer } from "@/lib/postpeer";

/**
 * Upload raw bytes to PostPeer's media store and return the public URL.
 *
 * PostPeer hands back a presigned S3 URL; we PUT the bytes server-side (the
 * browser can't, no CORS allowance). Shared by the direct upload route and the
 * dub-export handoff so both go through one code path.
 */
export async function uploadBufferToPostPeer(
	bytes: ArrayBuffer,
	filename: string,
	mimeType: string,
): Promise<{ publicUrl: string; type: "image" | "video" }> {
	const { uploadUrl, publicUrl } = await postpeer.presignMedia({
		filename,
		mimeType,
	});

	const put = await fetch(uploadUrl, {
		method: "PUT",
		headers: { "Content-Type": mimeType },
		body: bytes,
	});
	if (!put.ok) {
		const detail = await put.text().catch(() => "");
		throw new HttpError(
			502,
			`Storage upload failed (${put.status})${detail ? `: ${detail.slice(0, 180)}` : ""}`,
		);
	}

	return {
		publicUrl,
		type: mimeType.startsWith("video") ? "video" : "image",
	};
}
