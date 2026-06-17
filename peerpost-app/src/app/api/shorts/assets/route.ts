import type { NextRequest } from "next/server";
import { z } from "zod";
import { type AssetKind, getUserAssets, saveUserAsset } from "@/lib/assets";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";

export const runtime = "nodejs";

/** GET /api/shorts/assets — the current user's render asset URLs. */
export const GET = route(async () => {
	const user = await requireUser();
	return Response.json({ assets: await getUserAssets(user.id) });
});

const saveSchema = z.object({
	kind: z.enum(["overlay", "transition", "endcard"]),
	url: z.string().url().or(z.literal("")),
});

/** PUT /api/shorts/assets — set/clear one asset URL (uploaded via /api/media/upload). */
export const PUT = route(async (request: NextRequest) => {
	const user = await requireUser();
	const { kind, url } = saveSchema.parse(await request.json());
	await saveUserAsset(user.id, kind as AssetKind, url);
	return Response.json({ assets: await getUserAssets(user.id) });
});
