import { eq } from "drizzle-orm";
import { db } from "@/db";
import { userAssets } from "@/db/schema";

/** Per-user Shorts render assets (public URLs). */
export type AssetKind = "overlay" | "transition" | "endcard";

const COLUMN: Record<AssetKind, "overlayUrl" | "transitionUrl" | "endcardUrl"> =
	{
		overlay: "overlayUrl",
		transition: "transitionUrl",
		endcard: "endcardUrl",
	};

export type UserAssets = {
	overlay: string | null;
	transition: string | null;
	endcard: string | null;
};

export async function getUserAssets(userId: string): Promise<UserAssets> {
	const row = await db.query.userAssets.findFirst({
		where: eq(userAssets.userId, userId),
	});
	return {
		overlay: row?.overlayUrl ?? null,
		transition: row?.transitionUrl ?? null,
		endcard: row?.endcardUrl ?? null,
	};
}

/** Set or clear (empty string) one asset URL. */
export async function saveUserAsset(
	userId: string,
	kind: AssetKind,
	url: string,
): Promise<void> {
	const value = url.trim() === "" ? null : url.trim();
	await db
		.insert(userAssets)
		.values({ userId, [COLUMN[kind]]: value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: userAssets.userId,
			set: { [COLUMN[kind]]: value, updatedAt: new Date() },
		});
}
