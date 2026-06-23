import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { contentTags } from "@/db/schema";

/** itemId → tags[] for a set of Library items of one kind (current user). */
export async function loadTags(
	userId: string,
	kind: string,
	itemIds: string[],
): Promise<Record<string, string[]>> {
	if (itemIds.length === 0) return {};
	const rows = await db
		.select({ itemId: contentTags.itemId, tag: contentTags.tag })
		.from(contentTags)
		.where(
			and(
				eq(contentTags.userId, userId),
				eq(contentTags.kind, kind),
				inArray(contentTags.itemId, itemIds),
			),
		);
	const out: Record<string, string[]> = {};
	for (const r of rows) (out[r.itemId] ??= []).push(r.tag);
	return out;
}
