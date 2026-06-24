import type { NextRequest } from "next/server";
import { HttpError, requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import {
	loadArticlesPage,
	loadQuotesPage,
	loadTranscriptsPage,
	loadVideoPage,
} from "@/lib/library-queries";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ kind: string }> };

const LOADERS = {
	video: loadVideoPage,
	quotes: loadQuotesPage,
	articles: loadArticlesPage,
	transcript: loadTranscriptsPage,
} as const;

/**
 * GET /api/library/[kind]?offset=N — the next page of a shared gallery, used by
 * the "Show more" button. Filters/search stay client-side over loaded rows.
 */
export const GET = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { kind } = await params;
	const loader = LOADERS[kind as keyof typeof LOADERS];
	if (!loader) throw new HttpError(404, "Unknown gallery");

	const offset = Math.max(
		0,
		Number(new URL(req.url).searchParams.get("offset") ?? 0) || 0,
	);
	const { items, hasMore } = await loader(user.id, offset);
	return Response.json({ items, hasMore });
});
