"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { TagEditor } from "@/components/tag-editor";

type Item = {
	id: string;
	title: string;
	snippet: string;
	provider: string | null;
	tags: string[];
	createdAt: string;
};

export function ArticlesLibrary({ items }: { items: Item[] }) {
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(items.map((i) => [i.id, i.tags])),
	);
	const [search, setSearch] = useState("");
	const [sort, setSort] = useState("newest");

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		let list = items;
		if (q)
			list = list.filter(
				(i) =>
					i.title.toLowerCase().includes(q) ||
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
	}, [items, search, sort, tagsById]);

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
		</div>
	);
}
