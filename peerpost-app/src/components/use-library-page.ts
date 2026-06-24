"use client";

import { useCallback, useState } from "react";

/**
 * Light server-side pagination for the Library galleries: hold the loaded rows
 * in state and fetch the next page from /api/library/<kind> on demand. Filters
 * and search stay client-side over whatever's loaded. De-dupes by id so a row
 * inserted between page loads can't appear twice.
 */
export function useLibraryPage<T extends { id: string }>(
	kind: string,
	initialItems: T[],
	initialHasMore: boolean,
) {
	const [items, setItems] = useState<T[]>(initialItems);
	const [hasMore, setHasMore] = useState(initialHasMore);
	const [loadingMore, setLoadingMore] = useState(false);

	const loadMore = useCallback(async () => {
		setLoadingMore(true);
		try {
			const res = await fetch(`/api/library/${kind}?offset=${items.length}`);
			const d = await res.json();
			if (res.ok && Array.isArray(d.items)) {
				setItems((prev) => {
					const seen = new Set(prev.map((p) => p.id));
					return [...prev, ...(d.items as T[]).filter((x) => !seen.has(x.id))];
				});
				setHasMore(Boolean(d.hasMore));
			}
		} finally {
			setLoadingMore(false);
		}
	}, [kind, items.length]);

	return { items, setItems, hasMore, loadingMore, loadMore };
}
