import type { NextRequest } from "next/server";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { renderQuoteCard } from "@/lib/quote-card";

export const runtime = "nodejs";

const schema = z.object({
	photoUrl: z.string().url(),
	quote: z.string().min(1).max(2000),
	overlayUrl: z.string().url().optional(),
	panY: z.number().min(0).max(1).optional(),
	zoom: z.number().min(1).max(3).optional(),
	finalize: z.boolean().optional(),
});

/**
 * POST /api/quotes/card — render a quote image card via the sidecar.
 * Preview (default): streams PNG bytes. finalize:true: uploads to R2, returns
 * { publicUrl } for publishing.
 */
export const POST = route(async (req: NextRequest) => {
	await requireUser();
	const input = schema.parse(await req.json());
	const res = await renderQuoteCard(input);
	if (!res.ok) {
		const detail = await res.text().catch(() => "");
		throw new Error(
			`Card render failed (${res.status}). ${detail.slice(0, 200)}`,
		);
	}
	if (input.finalize) {
		return Response.json(await res.json());
	}
	// Stream the PNG straight back to the browser preview.
	const buf = await res.arrayBuffer();
	return new Response(buf, {
		headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
	});
});
