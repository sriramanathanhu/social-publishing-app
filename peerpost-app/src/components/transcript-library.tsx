"use client";

import { useMemo, useState } from "react";
import {
	type FilterMeta,
	LibraryFilters,
	metaOptions,
	passesMeta,
} from "@/components/library-filters";
import { TagEditor } from "@/components/tag-editor";

type Item = {
	id: string;
	title: string;
	lang: string;
	corpusKey: string | null;
	pushedAt: string | null;
	createdAt: string;
	transcript: string;
	author?: string;
	tags: string[];
};

const meta = (i: Item): FilterMeta => ({
	lang: i.lang,
	author: i.author ?? "",
	createdAt: i.createdAt,
});

export function TranscriptLibrary({ items }: { items: Item[] }) {
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(items.map((i) => [i.id, i.tags])),
	);
	const [search, setSearch] = useState("");
	const [langFilter, setLangFilter] = useState("all");
	const [userFilter, setUserFilter] = useState("all");
	const [dateFilter, setDateFilter] = useState(0);
	const [sort, setSort] = useState("pushed");

	const { langs, users } = useMemo(() => metaOptions(items.map(meta)), [items]);

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		let list = items.filter((i) =>
			passesMeta(meta(i), langFilter, userFilter, dateFilter),
		);
		if (q)
			list = list.filter(
				(i) =>
					i.title.toLowerCase().includes(q) ||
					(i.author ?? "").toLowerCase().includes(q) ||
					(tagsById[i.id] ?? []).some((t) => t.toLowerCase().includes(q)),
			);
		const s = [...list];
		s.sort((a, b) =>
			sort === "title"
				? a.title.localeCompare(b.title)
				: b.createdAt.localeCompare(a.createdAt),
		);
		return s;
	}, [items, search, langFilter, userFilter, dateFilter, sort, tagsById]);

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
					<option value="pushed">Recent</option>
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
			<div className="space-y-3">
				{view.map((t) => (
					<div
						key={t.id}
						className="rounded-lg border border-slate-200 bg-white p-4"
					>
						<details>
							<summary className="cursor-pointer font-medium text-slate-900">
								{t.title}
								<span className="ml-2 font-normal text-slate-400 text-xs">
									{t.lang}
									{t.pushedAt
										? ` · in corpus · ${new Date(t.pushedAt).toLocaleDateString()}`
										: " · not pushed"}
									{t.author ? ` · by ${t.author}` : ""}
									{!t.pushedAt
										? ` · ${new Date(t.createdAt).toLocaleDateString()}`
										: ""}
								</span>
							</summary>
							<div className="mt-3 max-h-96 overflow-y-auto whitespace-pre-wrap text-slate-700 text-sm">
								{t.transcript}
							</div>
						</details>
						<div className="mt-2">
							<TagEditor
								kind="transcript"
								itemId={t.id}
								initial={t.tags}
								onChange={(tags) =>
									setTagsById((x) => ({ ...x, [t.id]: tags }))
								}
							/>
						</div>
					</div>
				))}
			</div>
		</div>
	);
}
