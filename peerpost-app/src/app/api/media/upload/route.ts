import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadBufferToPostPeer } from "@/lib/media";

export const runtime = "nodejs";

// Cap upload size — the file is buffered in memory by the proxy, so bound it.
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200 MB

/**
 * POST /api/media/upload  (multipart form-data, field "file")
 *
 * Proxies the upload through our server: presign with PostPeer → PUT the bytes
 * to S3 server-side → return the public URL. Done server-side because the
 * browser can't PUT directly to PostPeer's S3 bucket (no CORS allowance →
 * "failed to fetch"). Returns { publicUrl, type }.
 */
export const POST = route(async (request: NextRequest) => {
	await requireUser();

	const form = await request.formData();
	const file = form.get("file");
	if (!(file instanceof File)) {
		return Response.json({ error: "No file provided" }, { status: 400 });
	}
	if (!/^(image|video)\//.test(file.type)) {
		return Response.json(
			{ error: "Only image/* or video/* files are allowed" },
			{ status: 400 },
		);
	}
	if (file.size > MAX_UPLOAD_BYTES) {
		const maxMb = Math.round(MAX_UPLOAD_BYTES / (1024 * 1024));
		return Response.json(
			{ error: `File too large (max ${maxMb} MB)` },
			{ status: 413 },
		);
	}

	const { publicUrl, type } = await uploadBufferToPostPeer(
		await file.arrayBuffer(),
		file.name,
		file.type,
	);

	return Response.json({ publicUrl, type, name: file.name });
});
