// Minimal PostPeer client for the MCP server (publish + cancel only).
// Reads metadata (ecosystems, accounts, analytics) come from our own DB.

const BASE_URL = process.env.POSTPEER_BASE_URL ?? "https://api.postpeer.dev/v1";

function key(): string {
	const k = process.env.POSTPEER_API_KEY;
	if (!k) throw new Error("POSTPEER_API_KEY is not set");
	return k;
}

export type PostPlatformInput = {
	platform: string;
	accountId: string;
	platformSpecificData?: Record<string, unknown>;
};

export type MediaItem = { type: "image" | "video"; url: string };

export type CreatePostInput = {
	content: string;
	platforms: PostPlatformInput[];
	mediaItems?: MediaItem[];
	publishNow?: boolean;
	scheduledFor?: string;
	timezone?: string;
};

export type CreatePostResult = {
	success: boolean;
	status?: string;
	postId?: string;
	message?: string;
	platforms?: {
		platform: string;
		success: boolean;
		error?: string;
		url?: string;
	}[];
};

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
	const res = await fetch(`${BASE_URL}${path}`, {
		...init,
		headers: {
			"x-access-key": key(),
			"Content-Type": "application/json",
			...(init.headers ?? {}),
		},
	});
	const text = await res.text();
	const body = text ? JSON.parse(text) : null;
	if (!res.ok && res.status >= 400) {
		const msg = body?.message ?? body?.error ?? `PostPeer error ${res.status}`;
		throw new Error(msg);
	}
	return body as T;
}

// ── Media: fetch a URL (incl. Google Drive links) → upload to PostPeer S3 ──────

const MIME_BY_EXT: Record<string, string> = {
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	png: "image/png",
	gif: "image/gif",
	webp: "image/webp",
	mp4: "video/mp4",
	mov: "video/quicktime",
	webm: "video/webm",
};

/** Detect mime from the file's magic bytes (used when none is given). */
export function sniffMime(b: Buffer): string | null {
	if (b.length < 12) return null;
	if (b[0] === 0x89 && b[1] === 0x50) return "image/png";
	if (b[0] === 0xff && b[1] === 0xd8) return "image/jpeg";
	if (b.toString("ascii", 0, 3) === "GIF") return "image/gif";
	if (
		b.toString("ascii", 0, 4) === "RIFF" &&
		b.toString("ascii", 8, 12) === "WEBP"
	)
		return "image/webp";
	if (b.toString("ascii", 4, 8) === "ftyp") return "video/mp4";
	return null;
}

/** Turn a Google Drive share link into a direct-download URL. */
export function normalizeUrl(url: string): string {
	const m = url.match(
		/drive\.google\.com\/(?:file\/d\/|open\?id=|uc\?(?:[\s\S]*?&)?id=)([\w-]+)/,
	);
	if (m) return `https://drive.google.com/uc?export=download&id=${m[1]}`;
	return url;
}

async function presignMedia(filename: string, mimeType: string) {
	const r = await req<{
		success: boolean;
		data: { uploadUrl: string; publicUrl: string };
	}>("/media/upload", {
		method: "POST",
		body: JSON.stringify({ filename, mimeType }),
	});
	return r.data;
}

/** Upload raw bytes to PostPeer storage → a mediaItem. Shared by URL + Drive. */
export async function uploadBytes(
	bytes: Buffer,
	mimeType: string,
	name: string,
): Promise<MediaItem> {
	let mime = (mimeType ?? "").split(";")[0].trim();
	const ext = name.split(".").pop()?.toLowerCase() ?? "";
	if (!mime || mime === "application/octet-stream") {
		mime = sniffMime(bytes) ?? MIME_BY_EXT[ext] ?? "image/jpeg";
	}
	if (!/^(image|video)\//.test(mime)) {
		throw new Error(`Unsupported media type: ${mime}`);
	}
	const filename = name || `media.${ext || "jpg"}`;
	const { uploadUrl, publicUrl } = await presignMedia(filename, mime);
	const put = await fetch(uploadUrl, {
		method: "PUT",
		headers: { "Content-Type": mime },
		body: new Uint8Array(bytes),
	});
	if (!put.ok) throw new Error(`Upload to storage failed (HTTP ${put.status})`);
	return { type: mime.startsWith("video") ? "video" : "image", url: publicUrl };
}

/**
 * Fetch an image/video from any public URL (or public Google Drive file link)
 * and upload it. Private Drive files/folders use the Drive API path instead.
 */
export async function uploadFromUrl(url: string): Promise<MediaItem> {
	const direct = normalizeUrl(url);
	const resp = await fetch(direct, { redirect: "follow" });
	if (!resp.ok) throw new Error(`Couldn't fetch ${url} (HTTP ${resp.status})`);

	const mime = (resp.headers.get("content-type") ?? "").split(";")[0].trim();
	if (mime === "text/html") {
		throw new Error(
			`That link returned a web page, not a file. For Google Drive, share it "anyone with the link" (or configure the Drive service account for private files).`,
		);
	}
	const name = direct.split("?")[0].split("/").pop() || "media";
	return uploadBytes(Buffer.from(await resp.arrayBuffer()), mime, name);
}

/** Split a base64 entry (raw, or a "data:<mime>;base64,…" URI) into mime+bytes. */
export function parseBase64Media(entry: string): {
	mime: string;
	bytes: Buffer;
} {
	const m = entry.match(/^data:([^;,]+);base64,([\s\S]*)$/);
	const mime = m ? m[1] : "";
	const b64 = (m ? m[2] : entry).trim();
	return { mime, bytes: Buffer.from(b64, "base64") };
}

/**
 * Upload an image/video passed as base64 (raw, or a data URI like
 * "data:image/png;base64,…"). This is how a ChatGPT/Claude-GENERATED image gets
 * posted: the model has a local/sandbox file, not a public URL, so it sends the
 * bytes directly.
 */
export async function uploadBase64(entry: string): Promise<MediaItem> {
	const { mime, bytes } = parseBase64Media(entry);
	if (bytes.length === 0) throw new Error("Empty or invalid base64 media.");
	return uploadBytes(bytes, mime, "upload");
}

export const postpeer = {
	createPost: (input: CreatePostInput) =>
		req<CreatePostResult>("/posts/", {
			method: "POST",
			body: JSON.stringify(input),
		}),
	cancelScheduled: (postId: string) =>
		req<unknown>(`/posts/scheduled/${postId}`, { method: "DELETE" }),
	uploadFromUrl,
	uploadBytes,
	uploadBase64,
};
