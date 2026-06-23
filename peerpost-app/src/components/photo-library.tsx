"use client";

import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { TagEditor } from "@/components/tag-editor";

type Item = { id: string; url: string; label: string | null; tags: string[] };
type Section = {
	kind: "background" | "overlay";
	title: string;
	items: Item[];
	uploadUrl: string;
	deleteBase: string;
	accept: string;
	checkered?: boolean;
};

export function PhotoLibrary({
	sections,
	editable,
}: {
	sections: Section[];
	editable: boolean;
}) {
	const router = useRouter();
	const [search, setSearch] = useState("");
	const [typeFilter, setTypeFilter] = useState("all");
	const [tagsById, setTagsById] = useState<Record<string, string[]>>(() =>
		Object.fromEntries(
			sections.flatMap((s) => s.items.map((i) => [i.id, i.tags])),
		),
	);
	const [busy, setBusy] = useState(false);
	const bgRef = useRef<HTMLInputElement>(null);
	const ovRef = useRef<HTMLInputElement>(null);

	const q = search.trim().toLowerCase();
	const shown = useMemo(
		() =>
			sections
				.filter((s) => typeFilter === "all" || s.kind === typeFilter)
				.map((s) => ({
					...s,
					items: s.items.filter(
						(i) =>
							!q ||
							(i.label ?? "").toLowerCase().includes(q) ||
							(tagsById[i.id] ?? []).some((t) => t.toLowerCase().includes(q)),
					),
				})),
		[sections, typeFilter, q, tagsById],
	);

	async function upload(s: Section, file: File) {
		setBusy(true);
		try {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch(s.uploadUrl, { method: "POST", body: fd });
			if (res.ok) router.refresh();
		} finally {
			setBusy(false);
		}
	}

	async function remove(s: Section, id: string) {
		if (!window.confirm("Delete this image?")) return;
		const res = await fetch(`${s.deleteBase}/${id}`, { method: "DELETE" });
		if (res.ok) router.refresh();
	}

	return (
		<div className="space-y-5">
			<div className="flex flex-wrap items-center gap-2">
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search label or tag…"
					className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
				/>
				<select
					value={typeFilter}
					onChange={(e) => setTypeFilter(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="all">All types</option>
					<option value="background">Backgrounds</option>
					<option value="overlay">Overlays</option>
				</select>
				{editable && (
					<>
						<button
							type="button"
							onClick={() => bgRef.current?.click()}
							disabled={busy}
							className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
						>
							Upload background
						</button>
						<button
							type="button"
							onClick={() => ovRef.current?.click()}
							disabled={busy}
							className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50 disabled:opacity-50"
						>
							Upload overlay
						</button>
						<input
							ref={bgRef}
							type="file"
							accept="image/jpeg,image/png,image/webp"
							className="hidden"
							onChange={(e) => {
								const f = e.target.files?.[0];
								const s = sections.find((x) => x.kind === "background");
								if (f && s) upload(s, f);
								e.target.value = "";
							}}
						/>
						<input
							ref={ovRef}
							type="file"
							accept="image/png"
							className="hidden"
							onChange={(e) => {
								const f = e.target.files?.[0];
								const s = sections.find((x) => x.kind === "overlay");
								if (f && s) upload(s, f);
								e.target.value = "";
							}}
						/>
					</>
				)}
			</div>

			{shown.map((s) => (
				<section key={s.kind} className="space-y-2">
					<h2 className="font-semibold text-slate-700 text-sm">
						{s.title} ({s.items.length})
					</h2>
					{s.items.length === 0 ? (
						<p className="text-slate-400 text-sm">Nothing here.</p>
					) : (
						<div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
							{s.items.map((it) => (
								<div key={it.id} className="space-y-1">
									{/* biome-ignore lint/performance/noImgElement: thumbnail */}
									<img
										src={it.url}
										alt={it.label ?? s.title}
										className={`aspect-[4/5] w-full rounded-lg border border-slate-200 object-cover ${s.checkered ? "bg-[length:16px_16px] bg-[linear-gradient(45deg,#ddd_25%,transparent_25%),linear-gradient(-45deg,#ddd_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#ddd_75%),linear-gradient(-45deg,transparent_75%,#ddd_75%)] [background-position:0_0,0_8px,8px_-8px,-8px_0]" : ""}`}
									/>
									<TagEditor
										kind={s.kind}
										itemId={it.id}
										initial={it.tags}
										onChange={(tags) =>
											setTagsById((t) => ({ ...t, [it.id]: tags }))
										}
									/>
									{editable && (
										<button
											type="button"
											onClick={() => remove(s, it.id)}
											className="text-[10px] text-red-600 hover:underline"
										>
											Delete
										</button>
									)}
								</div>
							))}
						</div>
					)}
				</section>
			))}
		</div>
	);
}
