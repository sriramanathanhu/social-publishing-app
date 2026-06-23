"use client";

import { useMemo, useState } from "react";
import {
	type BulkItem,
	BulkPublishPanel,
} from "@/components/bulk-publish-panel";
import type { Ecosystem } from "@/components/publish-row";
import { TagEditor } from "@/components/tag-editor";

type Item = {
	id: string;
	text: string;
	cardUrl: string | null;
	tags: string[];
	createdAt: string;
};

export function QuotesLibrary({
	items,
	ecosystems,
}: {
	items: Item[];
	ecosystems: Ecosystem[];
}) {
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(items.map((i) => [i.id, i.tags])),
	);
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState("all");
	const [sort, setSort] = useState("newest");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [showPublish, setShowPublish] = useState(false);

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		let list = items;
		if (filter === "card") list = list.filter((i) => i.cardUrl);
		if (filter === "text") list = list.filter((i) => !i.cardUrl);
		if (q)
			list = list.filter(
				(i) =>
					i.text.toLowerCase().includes(q) ||
					(tagsById[i.id] ?? []).some((t) => t.toLowerCase().includes(q)),
			);
		const s = [...list];
		s.sort((a, b) =>
			sort === "oldest"
				? a.createdAt.localeCompare(b.createdAt)
				: b.createdAt.localeCompare(a.createdAt),
		);
		return s;
	}, [items, filter, search, sort, tagsById]);

	function toggle(id: string) {
		setSelected((s) => {
			const n = new Set(s);
			n.has(id) ? n.delete(id) : n.add(id);
			return n;
		});
	}

	const bulkItems: BulkItem[] = view
		.filter((i) => selected.has(i.id) && i.cardUrl)
		.map((i) => ({
			id: i.id,
			mediaType: "image",
			url: i.cardUrl as string,
			caption: i.text,
		}));

	return (
		<div className="space-y-4">
			{showPublish && bulkItems.length > 0 && (
				<BulkPublishPanel
					items={bulkItems}
					ecosystems={ecosystems}
					onClose={() => setShowPublish(false)}
				/>
			)}

			<div className="flex flex-wrap items-center gap-2">
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search text or tag…"
					className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
				/>
				<select
					value={filter}
					onChange={(e) => setFilter(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="all">All</option>
					<option value="card">With card</option>
					<option value="text">Text only</option>
				</select>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="newest">Newest</option>
					<option value="oldest">Oldest</option>
				</select>
				{selected.size > 0 && (
					<button
						type="button"
						onClick={() => setShowPublish(true)}
						className="rounded-lg border border-slate-900 px-3 py-1.5 font-medium text-slate-900 text-sm"
					>
						Publish {bulkItems.length} card{bulkItems.length === 1 ? "" : "s"}
					</button>
				)}
				{selected.size > 0 && bulkItems.length === 0 && (
					<span className="text-amber-600 text-xs">
						Selected quotes have no card to publish.
					</span>
				)}
			</div>

			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
				{view.map((q) => (
					<div
						key={q.id}
						className={`rounded-lg border p-1.5 ${selected.has(q.id) ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200"}`}
					>
						<div className="relative">
							<input
								type="checkbox"
								checked={selected.has(q.id)}
								onChange={() => toggle(q.id)}
								className="absolute top-1 left-1 z-10"
							/>
							{q.cardUrl ? (
								<a href={q.cardUrl} target="_blank" rel="noreferrer">
									{/* biome-ignore lint/performance/noImgElement: card thumb */}
									<img
										src={q.cardUrl}
										alt={q.text.slice(0, 40)}
										className="aspect-[4/5] w-full rounded object-cover"
									/>
								</a>
							) : (
								<div className="flex aspect-[4/5] w-full items-center justify-center rounded bg-slate-50 p-2 text-center text-[11px] text-slate-600">
									{q.text.slice(0, 120)}
								</div>
							)}
						</div>
						<div className="mt-1">
							<TagEditor
								kind="quote"
								itemId={q.id}
								initial={q.tags}
								onChange={(tags) =>
									setTagsById((t) => ({ ...t, [q.id]: tags }))
								}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
