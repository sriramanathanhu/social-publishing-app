"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
	type BulkItem,
	BulkPublishPanel,
} from "@/components/bulk-publish-panel";
import type { Ecosystem } from "@/components/publish-row";
import { TagEditor } from "@/components/tag-editor";
import { useLibraryPage } from "@/components/use-library-page";
import { DUB_LANGUAGES, langLabel } from "@/lib/dub-options";

type Kind = "video" | "short" | "dub";
type Item = {
	id: string;
	kind: Kind;
	title: string;
	url: string;
	tags: string[];
	createdAt: string;
	userName: string;
	lang: string | null;
	durationSec?: number | null;
	viralScore?: number | null;
};

// "Date generated" presets (days back; 0 = all time).
const DATE_PRESETS: [string, number][] = [
	["All dates", 0],
	["Last 24 hours", 1],
	["Last 7 days", 7],
	["Last 30 days", 30],
	["Last 90 days", 90],
];

const TYPE_LABEL: Record<string, string> = {
	all: "All types",
	video: "Uploaded",
	short: "Generated short",
	dub: "Dubbed output",
};

export function VideoLibrary({
	items: initialItems,
	hasMore: initialHasMore,
	dubBySource,
	ecosystems,
	me,
}: {
	items: Item[];
	hasMore: boolean;
	dubBySource: Record<string, { lang: string; url: string }[]>;
	ecosystems: Ecosystem[];
	me: string;
}) {
	const { items, setItems, hasMore, loadingMore, loadMore } =
		useLibraryPage<Item>("video", initialItems, initialHasMore);
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
	const [typeFilter, setTypeFilter] = useState("all");
	const [langFilter, setLangFilter] = useState("all");
	const [userFilter, setUserFilter] = useState("all");
	const [dateFilter, setDateFilter] = useState(0);
	const [sort, setSort] = useState("newest");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [showPublish, setShowPublish] = useState(false);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [uploadProgress, setUploadProgress] = useState<{
		done: number;
		total: number;
	} | null>(null);
	const [dubLang, setDubLang] = useState(DUB_LANGUAGES[0].code);
	const [dubBusy, setDubBusy] = useState(false);
	const [dubDone, setDubDone] = useState(0);
	const [dubMsg, setDubMsg] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	const all = items;

	// Distinct languages + users present, for the filter dropdowns.
	const langOptions = useMemo(() => {
		const m = new Map<string, string>();
		for (const i of all) if (i.lang) m.set(i.lang, langLabel(i.lang));
		return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
	}, [all]);
	const userOptions = useMemo(
		() => [...new Set(all.map((i) => i.userName))].sort(),
		[all],
	);

	const view = useMemo(() => {
		const q = search.trim().toLowerCase();
		const since = dateFilter ? Date.now() - dateFilter * 86_400_000 : 0;
		let list = all.filter((i) => typeFilter === "all" || i.kind === typeFilter);
		if (langFilter !== "all") list = list.filter((i) => i.lang === langFilter);
		if (userFilter !== "all")
			list = list.filter((i) => i.userName === userFilter);
		if (since)
			list = list.filter((i) => new Date(i.createdAt).getTime() >= since);
		if (q)
			list = list.filter(
				(i) =>
					i.title.toLowerCase().includes(q) ||
					i.userName.toLowerCase().includes(q) ||
					(tagsById[i.id] ?? []).some((t) => t.toLowerCase().includes(q)),
			);
		const s = [...list];
		s.sort((a, b) => {
			if (sort === "title") return a.title.localeCompare(b.title);
			if (sort === "duration")
				return (b.durationSec ?? 0) - (a.durationSec ?? 0);
			if (sort === "viral") return (b.viralScore ?? 0) - (a.viralScore ?? 0);
			if (sort === "oldest") return a.createdAt.localeCompare(b.createdAt);
			return b.createdAt.localeCompare(a.createdAt); // newest
		});
		return s;
	}, [
		all,
		typeFilter,
		langFilter,
		userFilter,
		dateFilter,
		search,
		sort,
		tagsById,
	]);

	async function uploadOne(file: File): Promise<boolean> {
		// Stream the raw file as the request body (no multipart) so the server can
		// pipe it straight to R2 without buffering — name/type travel in headers.
		const res = await fetch("/api/video", {
			method: "POST",
			headers: {
				"Content-Type": file.type || "video/mp4",
				"x-filename": encodeURIComponent(file.name),
			},
			body: file,
		});
		const d = await res.json();
		if (!res.ok) throw new Error(d.error ?? "Upload failed");
		const v: Item = {
			id: d.video.id,
			kind: "video",
			title: d.video.title,
			url: d.video.url,
			tags: [],
			createdAt: String(d.video.createdAt),
			userName: me,
			lang: null,
		};
		setItems((p) => [v, ...p]);
		setTagsById((t) => ({ ...t, [v.id]: [] }));
		return true;
	}

	// Upload one or many videos: POST each in turn, with a progress count.
	async function upload(files: FileList) {
		setUploadBusy(true);
		setError(null);
		setUploadProgress(
			files.length > 1 ? { done: 0, total: files.length } : null,
		);
		let fail = 0;
		let firstErr: string | null = null;
		for (const file of Array.from(files)) {
			try {
				await uploadOne(file);
			} catch (e) {
				fail++;
				if (!firstErr)
					firstErr = e instanceof Error ? e.message : "Upload failed";
			}
			setUploadProgress((p) => (p ? { ...p, done: p.done + 1 } : p));
		}
		setUploadBusy(false);
		setUploadProgress(null);
		if (fail)
			setError(`${fail} of ${files.length} uploads failed: ${firstErr}`);
	}

	async function removeUpload(id: string) {
		setItems((p) => p.filter((v) => v.id !== id));
		setSelected((s) => {
			const n = new Set(s);
			n.delete(id);
			return n;
		});
		await fetch(`/api/video/${id}`, { method: "DELETE" }).catch(() => {});
	}

	function toggle(id: string) {
		setSelected((s) => {
			const n = new Set(s);
			n.has(id) ? n.delete(id) : n.add(id);
			return n;
		});
	}

	// Queue a dub job (target language `dubLang`) for every selected video. The
	// dubber-service caps concurrency, so the rest wait in its queue and process
	// as slots free. Outputs reappear here (as "Dubbed → …") once done.
	async function bulkDub() {
		const picked = all.filter((i) => selected.has(i.id));
		const voice = DUB_LANGUAGES.find((l) => l.code === dubLang)?.voices[0]?.id;
		if (picked.length === 0 || !voice) return;
		setDubBusy(true);
		setDubMsg(null);
		setDubDone(0);
		let ok = 0;
		let fail = 0;
		let firstErr: string | null = null;
		for (const it of picked) {
			try {
				const res = await fetch("/api/dub", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceType: "upload",
						sourceInput: it.url,
						sourceLang: "auto",
						targetLang: dubLang,
						voice,
						sourceLibraryId: it.id,
						sourceLibraryKind:
							it.kind === "short"
								? "short"
								: it.kind === "video"
									? "upload"
									: undefined,
					}),
				});
				if (res.ok) ok++;
				else {
					fail++;
					if (!firstErr) {
						const d = await res.json().catch(() => ({}));
						firstErr = d.error ?? `HTTP ${res.status}`;
					}
				}
			} catch {
				fail++;
			}
			setDubDone((d) => d + 1);
		}
		setDubBusy(false);
		setDubMsg(
			ok
				? `Queued ${ok} dub job${ok === 1 ? "" : "s"} → ${langLabel(dubLang)}${fail ? ` · ${fail} failed` : ""}. They'll appear here when done.`
				: `Couldn't queue dubs: ${firstErr ?? "failed"}`,
		);
		if (ok) setSelected(new Set());
	}

	const bulkItems: BulkItem[] = view
		.filter((i) => selected.has(i.id))
		.map((i) => ({
			id: i.id,
			mediaType: "video",
			url: i.url,
			caption: i.title,
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

			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-2">
				<input
					value={search}
					onChange={(e) => setSearch(e.target.value)}
					placeholder="Search title or tag…"
					className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm"
				/>
				<select
					value={typeFilter}
					onChange={(e) => setTypeFilter(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					{Object.entries(TYPE_LABEL).map(([v, l]) => (
						<option key={v} value={v}>
							{l}
						</option>
					))}
				</select>
				<select
					value={langFilter}
					onChange={(e) => setLangFilter(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
					title="Filter by language (shorts / dub output)"
				>
					<option value="all">All languages</option>
					{langOptions.map(([code, label]) => (
						<option key={code} value={code}>
							{label}
						</option>
					))}
				</select>
				<select
					value={userFilter}
					onChange={(e) => setUserFilter(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
					title="Filter by who uploaded / generated / dubbed"
				>
					<option value="all">All users</option>
					{userOptions.map((u) => (
						<option key={u} value={u}>
							{u}
						</option>
					))}
				</select>
				<select
					value={dateFilter}
					onChange={(e) => setDateFilter(Number(e.target.value))}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
					title="Filter by date generated"
				>
					{DATE_PRESETS.map(([label, days]) => (
						<option key={days} value={days}>
							{label}
						</option>
					))}
				</select>
				<select
					value={sort}
					onChange={(e) => setSort(e.target.value)}
					className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm"
				>
					<option value="newest">Newest</option>
					<option value="oldest">Oldest</option>
					<option value="title">Title</option>
					<option value="duration">Duration</option>
					<option value="viral">Viral score</option>
				</select>
				<button
					type="button"
					onClick={() => fileRef.current?.click()}
					disabled={uploadBusy}
					className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-50"
				>
					{uploadBusy
						? uploadProgress
							? `Uploading… (${uploadProgress.done}/${uploadProgress.total})`
							: "Uploading…"
						: "Upload videos"}
				</button>
				<input
					ref={fileRef}
					type="file"
					accept="video/*"
					multiple
					className="hidden"
					onChange={(e) => {
						if (e.target.files?.length) upload(e.target.files);
						e.target.value = "";
					}}
				/>
				{selected.size > 0 && (
					<button
						type="button"
						onClick={() => setShowPublish(true)}
						className="rounded-lg border border-slate-900 px-3 py-1.5 font-medium text-slate-900 text-sm"
					>
						Publish {selected.size} selected
					</button>
				)}
				{selected.size > 0 && (
					<span className="flex items-center gap-1.5 rounded-lg border border-slate-300 px-2 py-1">
						<select
							value={dubLang}
							onChange={(e) => setDubLang(e.target.value)}
							disabled={dubBusy}
							className="rounded border-0 bg-transparent text-sm focus:outline-none"
							title="Dub language"
						>
							{DUB_LANGUAGES.map((l) => (
								<option key={l.code} value={l.code}>
									{l.label}
								</option>
							))}
						</select>
						<button
							type="button"
							onClick={bulkDub}
							disabled={dubBusy}
							className="rounded-md bg-indigo-600 px-2.5 py-1 font-medium text-sm text-white disabled:opacity-50"
						>
							{dubBusy
								? `Queuing… (${dubDone}/${selected.size})`
								: `Dub ${selected.size} → queue`}
						</button>
					</span>
				)}
				{dubMsg && <span className="text-indigo-700 text-sm">{dubMsg}</span>}
				{error && <span className="text-red-600 text-sm">{error}</span>}
			</div>

			{view.length === 0 ? (
				<p className="text-slate-400 text-sm">Nothing here.</p>
			) : (
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
					{view.map((i) => {
						const dubbed = dubBySource[i.id];
						return (
							<div
								key={i.id}
								className={`rounded-lg border p-1.5 ${selected.has(i.id) ? "border-slate-900 ring-1 ring-slate-900" : "border-slate-200"}`}
							>
								<div className="relative">
									<input
										type="checkbox"
										checked={selected.has(i.id)}
										onChange={() => toggle(i.id)}
										className="absolute top-1 left-1 z-10"
									/>
									{/* biome-ignore lint/a11y/useMediaCaption: preview */}
									<video
										src={i.url}
										controls
										preload="none"
										className="aspect-[9/16] w-full rounded bg-black object-cover"
									/>
								</div>
								<div
									className="mt-1 truncate text-slate-700 text-xs"
									title={i.title}
								>
									{i.title}
								</div>
								<div className="flex flex-wrap items-center gap-1 text-[10px] text-slate-400">
									<span className="rounded bg-slate-100 px-1">
										{TYPE_LABEL[i.kind]}
									</span>
									{i.lang ? (
										<span className="rounded bg-slate-100 px-1">
											{langLabel(i.lang)}
										</span>
									) : null}
									{i.durationSec ? <span>{i.durationSec}s</span> : null}
									{i.viralScore ? <span>★{i.viralScore}</span> : null}
								</div>
								<div
									className="truncate text-[10px] text-slate-400"
									title={i.userName}
								>
									by {i.userName}
								</div>
								{dubbed && dubbed.length > 0 && (
									<div className="mt-0.5 flex flex-wrap gap-1 text-[10px]">
										<span className="text-slate-400">dubbed:</span>
										{dubbed.map((d) => (
											<a
												key={d.lang + d.url}
												href={d.url}
												target="_blank"
												rel="noreferrer"
												className="rounded bg-indigo-100 px-1 text-indigo-700 hover:underline"
											>
												{d.lang}
											</a>
										))}
									</div>
								)}
								<div className="mt-1">
									<TagEditor
										kind={i.kind}
										itemId={i.id}
										initial={i.tags}
										onChange={(tags) =>
											setTagsById((t) => ({ ...t, [i.id]: tags }))
										}
									/>
								</div>
								{i.kind === "video" && (
									<button
										type="button"
										onClick={() => removeUpload(i.id)}
										className="mt-0.5 text-[10px] text-red-600 hover:underline"
									>
										Delete
									</button>
								)}
							</div>
						);
					})}
				</div>
			)}
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
