"use client";

import { useMemo, useState } from "react";
import { TagEditor } from "@/components/tag-editor";

type Item = {
	id: string;
	title: string;
	lang: string;
	corpusKey: string | null;
	pushedAt: string | null;
	transcript: string;
	author?: string;
	tags: string[];
};

export function TranscriptLibrary({ items }: { items: Item[] }) {
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(items.map((i) => [i.id, i.tags])),
	);
	const [search, setSearch] = useState("");
	const [lang, setLang] = useState("all");
	const [sort, setSort] = useState("pushed");

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		let list = items;
		if (lang !== "all") list = list.filter((i) => i.lang === lang);
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
				: (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
		);
		return s;
	}, [items, search, lang, sort, tagsById]);

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
					value={lang}
					onChange={(e) => setLang(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="all">All languages</option>
					<option value="Tamil">Tamil</option>
					<option value="English">English</option>
				</select>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="pushed">Pushed date</option>
					<option value="title">Title</option>
				</select>
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
									{t.lang} · in corpus
									{t.author ? ` · by ${t.author}` : ""}
									{t.pushedAt
										? ` · ${new Date(t.pushedAt).toLocaleString()}`
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
