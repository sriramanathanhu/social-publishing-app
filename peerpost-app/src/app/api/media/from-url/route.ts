import type { NextRequest } from "next/server";
import { z } from "zod";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { uploadBufferToPostPeer } from "@/lib/media";

export const runtime = "nodejs";

const MAX_BYTES = 200 * 1024 * 1024; // 200 MB
const schema = z.object({ url: z.string().url() });

/**
 * Local-dev only: clips stored on the dubber sidecar (no R2) get a
 * browser-reachable public URL (DUBBER_PUBLIC_BASE_URL, e.g.
 * http://localhost:8800). The app server can't reach the host's localhost, so
 * swap that base for the internal compose hostname (DUBBER_SERVICE_URL) before
 * fetching server-side. No-op when either var is unset (i.e. R2 mode).
 */
function internalizeDubberUrl(url: string): string {
	const pub = (process.env.DUBBER_PUBLIC_BASE_URL ?? "").replace(/\/+$/, "");
	const internal = (process.env.DUBBER_SERVICE_URL ?? "").replace(/\/+$/, "");
	if (pub && internal && url.startsWith(pub)) {
		return internal + url.slice(pub.length);
	}
	return url;
}

/**
 * POST /api/media/from-url  { url }
 *
 * Re-hosts an already-public media URL (e.g. an R2 shorts clip) into the
 * PostPeer media store and returns the PostPeer publicUrl — the form the
 * providers reliably accept when publishing. Used by the Shorts publish table.
 */
export const POST = route(async (request: NextRequest) => {
	await requireUser();
	const { url } = schema.parse(await request.json());

	const resp = await fetch(internalizeDubberUrl(url), { cache: "no-store" });
	if (!resp.ok) {
		throw new HttpError(502, "Could not fetch the source media");
	}
	const contentType = resp.headers.get("content-type") ?? "video/mp4";
	const bytes = await resp.arrayBuffer();
	if (bytes.byteLength > MAX_BYTES) {
		throw new HttpError(413, "Media is too large to publish");
	}
	const name = url.split("/").pop()?.split("?")[0] || "media.mp4";

	const { publicUrl, type } = await uploadBufferToPostPeer(
		bytes,
		name,
		contentType,
	);
	return Response.json({ publicUrl, type });
});
