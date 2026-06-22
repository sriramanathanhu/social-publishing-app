import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { assertAdmin } from "@/lib/rbac";
import { searchCorpus, vertexConfigured } from "@/lib/vertex-search";

export const runtime = "nodejs";

/**
 * GET /api/articles/health?q=... — admin connectivity test for Vertex AI Search.
 * Returns whether it's configured and a sample of retrieved passages, so we can
 * verify the service-account + data store the moment credentials are added.
 */
export const GET = route(async (req: NextRequest) => {
	const user = await requireUser();
	assertAdmin(user);
	if (!vertexConfigured()) {
		return Response.json({
			configured: false,
			need: [
				"GOOGLE_VERTEX_PROJECT",
				"GOOGLE_VERTEX_LOCATION (global|us|eu)",
				"GOOGLE_VERTEX_DATASTORE or GOOGLE_VERTEX_ENGINE",
				"GOOGLE_SERVICE_ACCOUNT_JSON",
			],
		});
	}
	const q = req.nextUrl.searchParams.get("q") || "test";
	try {
		const passages = await searchCorpus(q, { pageSize: 3 });
		return Response.json({
			configured: true,
			ok: true,
			query: q,
			hits: passages.length,
			sample: passages.slice(0, 3).map((p) => ({
				title: p.title,
				uri: p.uri,
				preview: (p.segments[0] ?? p.snippets[0] ?? "").slice(0, 160),
			})),
		});
	} catch (e) {
		return Response.json({
			configured: true,
			ok: false,
			error: e instanceof Error ? e.message : String(e),
		});
	}
});
