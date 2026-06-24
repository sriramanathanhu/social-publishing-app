"use client";

import { useMemo } from "react";
import type { Ecosystem } from "@/components/publish-row";
import { QuoteBatch } from "@/components/quote-batch";
import type {
	QuoteBackground,
	QuoteItem,
	QuoteOverlay,
} from "@/components/quote-types";

/**
 * Groups the saved quotes by the generation that made them and renders one
 * self-contained QuoteBatch per group (newest first). Each batch carries its
 * OWN style, render, target accounts and schedule, so batches don't interfere.
 */
export function QuoteBatchPanel({
	items,
	backgrounds,
	overlays,
	ecosystems,
	onChange,
}: {
	readonly items: QuoteItem[];
	readonly backgrounds: QuoteBackground[];
	readonly overlays: QuoteOverlay[];
	readonly ecosystems: Ecosystem[];
	readonly onChange: (id: string, patch: Partial<QuoteItem>) => void;
}) {
	const batches = useMemo(() => {
		const order: string[] = [];
		const map = new Map<string, QuoteItem[]>();
		for (const q of items) {
			const b = q.batchId ?? "_";
			if (!map.has(b)) {
				map.set(b, []);
				order.push(b);
			}
			map.get(b)?.push(q);
		}
		return order.map((b) => ({ batchId: b, items: map.get(b) ?? [] }));
	}, [items]);

	return (
		<div className="space-y-4">
			<h3 className="font-semibold text-sm">⚡ Batch cards &amp; schedule</h3>
			{batches.length === 0 ? (
				<p className="text-sm opacity-50">No quotes yet.</p>
			) : (
				batches.map((b, bi) => {
					const lang = b.items[0]?.outputLang;
					return (
						<QuoteBatch
							key={b.batchId}
							items={b.items}
							label={`${lang || "Default language"}${bi === 0 ? " · latest" : ""}`}
							backgrounds={backgrounds}
							overlays={overlays}
							ecosystems={ecosystems}
							onChange={onChange}
						/>
					);
				})
			)}
		</div>
	);
}
