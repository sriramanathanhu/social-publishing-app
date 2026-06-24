"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import {
	LibraryFilters,
	metaOptions,
	passesMeta,
} from "@/components/library-filters";
import { TagEditor } from "@/components/tag-editor";
import { useLibraryPage } from "@/components/use-library-page";

type Item = {
	id: string;
	title: string;
	snippet: string;
	provider: string | null;
	tags: string[];
	createdAt: string;
	author: string;
	lang: string | null;
};

export function ArticlesLibrary({
	items: initialItems,
	hasMore: initialHasMore,
}: {
	items: Item[];
	hasMore: boolean;
}) {
	const { items, hasMore, loadingMore, loadMore } = useLibraryPage<Item>(
		"articles",
		initialItems,
		initialHasMore,
	);
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(initialItems.map((i) => [i.id, i.tags])),
	);
	// Seed tags for rows brought in by "Show more".
	useEffect(() => {
		setTagsById((prev) => {
			const next = { ...prev };
			for (const i of items) if (!(i.id in next)) next[i.id] = i.tags;
			return next;
		});
	}, [items]);
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState("newest");
	const [langFilter, setLangFilter] = useState("all");
	const [userFilter, setUserFilter] = useState("all");
	const [dateFilter, setDateFilter] = useState(0);

	const { langs, users } = useMemo(() => metaOptions(items), [items]);

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		let list = items.filter((i) =>
			passesMeta(i, langFilter, userFilter, dateFilter),
		);
		if (q)
			list = list.filter(
				(i) =>
					i.title.toLowerCase().includes(q) ||
					i.author.toLowerCase().includes(q) ||
					(tagsById[i.id] ?? []).some((t) => t.toLowerCase().includes(q)),
			);
		const s = [...list];
		s.sort((a, b) =>
			sort === "title"
				? a.title.localeCompare(b.title)
				: sort === "oldest"
					? a.createdAt.localeCompare(b.createdAt)
					: b.createdAt.localeCompare(a.createdAt),
		);
		return s;
	}, [items, search, sort, tagsById, langFilter, userFilter, dateFilter]);

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-2">
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search title or tag…"
					className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
				/>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="newest">Newest</option>
					<option value="oldest">Oldest</option>
					<option value="title">Title</option>
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
			</div>
			<div className="space-y-2">
				{view.map((a) => (
					<div
						key={a.id}
						className="rounded-lg border border-slate-200 bg-white p-4"
					>
						<Link href="/articles" className="block hover:opacity-80">
							<div className="font-medium text-slate-900">{a.title}</div>
							<div className="mt-1 text-slate-500 text-sm">{a.snippet}…</div>
							<div className="mt-1 text-slate-400 text-xs">
								{new Date(a.createdAt).toLocaleDateString()}
								{a.lang ? ` · ${a.lang}` : ""}
								{a.author ? ` · by ${a.author}` : ""}
								{a.provider ? ` · ${a.provider}` : ""}
							</div>
						</Link>
						<div className="mt-2">
							<TagEditor
								kind="article"
								itemId={a.id}
								initial={a.tags}
								onChange={(tags) =>
									setTagsById((t) => ({ ...t, [a.id]: tags }))
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
