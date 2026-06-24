"use client";

import { useEffect, useMemo, useState } from "react";
import {
	type BulkItem,
	BulkPublishPanel,
} from "@/components/bulk-publish-panel";
import {
	LibraryFilters,
	metaOptions,
	passesMeta,
} from "@/components/library-filters";
import type { Ecosystem } from "@/components/publish-row";
import { TagEditor } from "@/components/tag-editor";
import { useLibraryPage } from "@/components/use-library-page";

type Item = {
	id: string;
	text: string;
	cardUrl: string | null;
	tags: string[];
	createdAt: string;
	author: string;
	lang: string | null;
};

export function QuotesLibrary({
	items: initialItems,
	hasMore: initialHasMore,
	ecosystems,
}: {
	items: Item[];
	hasMore: boolean;
	ecosystems: Ecosystem[];
}) {
	const { items, hasMore, loadingMore, loadMore } = useLibraryPage<Item>(
		"quotes",
		initialItems,
		initialHasMore,
	);
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(initialItems.map((i) => [i.id, i.tags])),
	);
	useEffect(() => {
		setTagsById((prev) => {
			const next = { ...prev };
			for (const i of items) if (!(i.id in next)) next[i.id] = i.tags;
			return next;
		});
	}, [items]);
	const [search, setSearch] = useState("");
	const [filter, setFilter] = useState("all");
	const [sort, setSort] = useState("newest");
	const [langFilter, setLangFilter] = useState("all");
	const [userFilter, setUserFilter] = useState("all");
	const [dateFilter, setDateFilter] = useState(0);
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [showPublish, setShowPublish] = useState(false);

	const { langs, users } = useMemo(() => metaOptions(items), [items]);

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		let list = items.filter((i) =>
			passesMeta(i, langFilter, userFilter, dateFilter),
		);
		if (filter === "card") list = list.filter((i) => i.cardUrl);
		if (filter === "text") list = list.filter((i) => !i.cardUrl);
		if (q)
			list = list.filter(
				(i) =>
					i.text.toLowerCase().includes(q) ||
					i.author.toLowerCase().includes(q) ||
					(tagsById[i.id] ?? []).some((t) => t.toLowerCase().includes(q)),
			);
		const s = [...list];
		s.sort((a, b) =>
			sort === "oldest"
				? a.createdAt.localeCompare(b.createdAt)
				: b.createdAt.localeCompare(a.createdAt),
		);
		return s;
	}, [
		items,
		filter,
		search,
		sort,
		tagsById,
		langFilter,
		userFilter,
		dateFilter,
	]);

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
				<LibraryFilters
					langs={langs}
					users={users}
					lang={langFilter}
					setLang={setLangFilter}
					user={userFilter}
					setUser={setUserFilter}
					date={dateFilter}
					setDate={setDateFilter}
				/>
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
										loading="lazy"
										className="aspect-[4/5] w-full rounded object-cover"
									/>
								</a>
							) : (
								<div className="flex aspect-[4/5] w-full items-center justify-center rounded bg-slate-50 p-2 text-center text-[11px] text-slate-600">
									{q.text.slice(0, 120)}
								</div>
							)}
						</div>
						{(q.lang || q.author) && (
							<div
								className="mt-0.5 truncate text-[10px] text-slate-400"
								title={`${q.lang ? `${q.lang} · ` : ""}${q.author}`}
							>
								{q.lang ? `${q.lang} · ` : ""}
								{q.author ? `by ${q.author}` : ""}
							</div>
						)}
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
			{hasMore && (
				<div className="flex justify-center pt-2">
					<button
						type="button"
						onClick={loadMore}
						disabled={loadingMore}
						className="rounded-lg border border-slate-300 px-4 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
					>
						{loadingMore ? "Loading…" : "Show more"}
					</button>
				</div>
			)}
		</div>
	);
}
