import type { NextRequest } from "next/server";
import { applyZernioStatus } from "@/lib/zernio-reconcile";
import type { ZernioPostStatus } from "@/lib/providers/zernio";

export const runtime = "nodejs";

/**
 * POST /api/webhooks/zernio?secret=… — Zernio post-status webhook.
 *
 * Zernio calls this whenever a post it holds changes state (published / failed /
 * publishing). We match on the provider post id and advance our posts_log row, so
 * the Scheduled view and the status summary reflect Zernio's real outcome instead
 * of staying "scheduled" forever.
 *
 * Auth: a shared secret on the query string (ZERNIO_WEBHOOK_SECRET), since the
 * webhook sender may not support custom headers. Always returns 200 on a valid
 * secret (even when the payload doesn't match a known post) so Zernio doesn't
 * treat a benign no-op as a delivery failure and retry forever.
 */

// Zernio's webhook body shape isn't formally documented; pull the id + status
// from the field names it's been observed to use, tolerating a few variations.
type WebhookBody = {
	event?: string;
	type?: string;
	post?: RawPost;
	data?: { post?: RawPost } & RawPost;
} & RawPost;

type RawPost = {
	_id?: string;
	id?: string;
	postId?: string;
	status?: string;
	error?: string;
	platforms?: {
		platform?: string;
		status?: string;
		platformPostUrl?: string;
		url?: string;
		error?: string;
	}[];
};

function pickPost(body: WebhookBody): RawPost | null {
	return body.post ?? body.data?.post ?? body.data ?? body ?? null;
}

function postIdOf(p: RawPost): string | null {
	return p._id ?? p.id ?? p.postId ?? null;
}

function toStatus(p: RawPost): ZernioPostStatus {
	const platforms = (p.platforms ?? []).map((x) => ({
		platform: x.platform ?? "",
		status: x.status ?? null,
		url: x.platformPostUrl || x.url || null,
		error: x.error || null,
	}));
	return {
		status: p.status ?? null,
		platforms,
		error: p.error || platforms.find((x) => x.error)?.error || null,
	};
}

export async function POST(req: NextRequest) {
	const expected = process.env.ZERNIO_WEBHOOK_SECRET ?? "";
	const provided =
		req.nextUrl.searchParams.get("secret") ??
		req.headers.get("x-webhook-secret") ??
		"";
	if (!expected || provided !== expected) {
		return new Response("Unauthorized", { status: 401 });
	}

	let body: WebhookBody;
	try {
		body = (await req.json()) as WebhookBody;
	} catch {
		return Response.json({ ok: false, error: "invalid json" }, { status: 400 });
	}

	const post = pickPost(body);
	const postId = post ? postIdOf(post) : null;
	if (!post || !postId) {
		// Valid secret but unrecognised payload — ack so Zernio won't retry.
		return Response.json({ ok: true, matched: false });
	}

	const applied = await applyZernioStatus(postId, toStatus(post));
	return Response.json({ ok: true, matched: true, postId, applied });
}
