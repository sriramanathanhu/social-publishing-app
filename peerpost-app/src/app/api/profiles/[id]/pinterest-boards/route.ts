import type { NextRequest } from "next/server";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { postpeer } from "@/lib/postpeer";
import { assertAccountInProfile } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/**
 * GET /api/profiles/:id/pinterest-boards?accountId=
 * Lists the Pinterest boards for a connected account (boardId is required when
 * publishing a pin). Access is gated to the ecosystem + account.
 */
export const GET = route(async (req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	const accountId = req.nextUrl.searchParams.get("accountId");
	if (!accountId) {
		return Response.json({ error: "accountId required" }, { status: 400 });
	}

	await assertAccountInProfile(user, id, accountId);

	const { boards } = await postpeer.getPinterestBoards(accountId);
	return Response.json({ boards });
});
