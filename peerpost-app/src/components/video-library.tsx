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
	caption?: string | null;
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
	const [dubLangs, setDubLangs] = useState<string[]>([]);
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

	function addUploaded(video: {
		id: string;
		title: string;
		url: string;
		createdAt: string;
	}) {
		const v: Item = {
			id: video.id,
			kind: "video",
			title: video.title,
			url: video.url,
			tags: [],
			createdAt: String(video.createdAt),
			userName: me,
			lang: null,
		};
		setItems((p) => [v, ...p]);
		setTagsById((t) => ({ ...t, [v.id]: [] }));
	}

	async function uploadOne(file: File): Promise<boolean> {
		const ct = file.type || "video/mp4";
		// Preferred: presign → upload straight to R2 (bypasses the app server and
		// Cloudflare's body limit, so multi-GB files work) → record the row.
		let presign: { uploadUrl?: string; key?: string; url?: string } | null =
			null;
		try {
			const pr = await fetch("/api/video/presign", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: file.name, type: ct, size: file.size }),
			});
			if (pr.ok) presign = await pr.json();
		} catch {
			presign = null;
		}

		if (presign?.uploadUrl) {
			const put = await fetch(presign.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": ct },
				body: file,
			});
			if (!put.ok) throw new Error(`Direct upload failed (${put.status})`);
			const rec = await fetch("/api/video", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					key: presign.key,
					url: presign.url,
					name: file.name,
					contentType: ct,
					size: file.size,
				}),
			});
			const d = await rec.json();
			if (!rec.ok) throw new Error(d.error ?? "Failed to record upload");
			addUploaded(d.video);
			return true;
		}

		// Fallback: stream through the app (bounded memory; under CF body limit).
		const res = await fetch("/api/video", {
			method: "POST",
			headers: {
				"Content-Type": ct,
				"x-filename": encodeURIComponent(file.name),
			},
			body: file,
		});
		const d = await res.json();
		if (!res.ok) throw new Error(d.error ?? "Upload failed");
		addUploaded(d.video);
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

	function clearSelection() {
		setSelected(new Set());
	}

	// Queue a dub job for every (selected video × selected language). The
	// dubber-service caps concurrency, so the rest wait in its queue and process
	// as slots free. Outputs reappear here (as "Dubbed → …") once done.
	async function bulkDub() {
		const picked = all.filter((i) => selected.has(i.id));
		if (picked.length === 0 || dubLangs.length === 0) return;
		setDubBusy(true);
		setDubMsg(null);
		setDubDone(0);
		let ok = 0;
		let fail = 0;
		let firstErr: string | null = null;
		for (const lang of dubLangs) {
			const voice = DUB_LANGUAGES.find((l) => l.code === lang)?.voices[0]?.id;
			if (!voice) continue;
			for (const it of picked) {
				try {
					const res = await fetch("/api/dub", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({
							sourceType: "upload",
							sourceInput: it.url,
							sourceLang: "auto",
							targetLang: lang,
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
		}
		setDubBusy(false);
		setDubMsg(
			ok
				? `Queued ${ok} dub job${ok === 1 ? "" : "s"} → ${dubLangs
						.map((l) => langLabel(l))
						.join(
							", ",
						)}${fail ? ` · ${fail} failed` : ""}. They'll appear here when done.`
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
			// Dubs carry an AI-generated title + description; fall back to the title.
			caption: i.caption || i.title,
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
								{i.caption && (
									<div
										className="mt-0.5 line-clamp-2 text-[10px] text-slate-500"
										title={i.caption}
									>
										{i.caption}
									</div>
								)}
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

			{/* Floating action bar — follows the viewport while a selection is active. */}
			{selected.size > 0 && (
				<div className="-translate-x-1/2 fixed bottom-5 left-1/2 z-40 flex max-w-[95vw] flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 shadow-xl">
					<span className="font-medium text-slate-800 text-sm">
						{selected.size} selected
					</span>
					<button
						type="button"
						onClick={clearSelection}
						className="rounded-lg border border-slate-300 px-2.5 py-1.5 text-sm hover:bg-slate-50"
					>
						Clear
					</button>
					<button
						type="button"
						onClick={() => setShowPublish(true)}
						className="rounded-lg border border-slate-900 px-3 py-1.5 font-medium text-slate-900 text-sm hover:bg-slate-50"
					>
						Publish {selected.size}
					</button>

					<span className="mx-1 h-6 w-px bg-slate-200" />

					{/* Multi-language dub queue */}
					<div className="flex flex-wrap items-center gap-1.5">
						{dubLangs.map((code) => (
							<span
								key={code}
								className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-1 text-indigo-700 text-xs"
							>
								{langLabel(code)}
								<button
									type="button"
									onClick={() =>
										setDubLangs((p) => p.filter((c) => c !== code))
									}
									disabled={dubBusy}
									className="leading-none hover:opacity-70"
									aria-label={`Remove ${langLabel(code)}`}
								>
									×
								</button>
							</span>
						))}
						<select
							value=""
							disabled={dubBusy}
							onChange={(e) => {
								const v = e.target.value;
								if (v && !dubLangs.includes(v)) setDubLangs((p) => [...p, v]);
							}}
							className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
							title="Add a dub language"
						>
							<option value="">
								{dubLangs.length ? "+ Add language" : "Dub language…"}
							</option>
							{DUB_LANGUAGES.filter((l) => !dubLangs.includes(l.code)).map(
								(l) => (
									<option key={l.code} value={l.code}>
										{l.label}
									</option>
								),
							)}
						</select>
						<button
							type="button"
							onClick={bulkDub}
							disabled={dubBusy || dubLangs.length === 0}
							className="rounded-lg bg-indigo-600 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-50"
							title="Queue a dub of each selected video into each chosen language"
						>
							{dubBusy
								? `Queuing… (${dubDone}/${selected.size * dubLangs.length})`
								: `Dub → queue${dubLangs.length ? ` (${selected.size}×${dubLangs.length})` : ""}`}
						</button>
					</div>
					{dubMsg && (
						<span className="w-full text-indigo-700 text-xs">{dubMsg}</span>
					)}
				</div>
			)}
		</div>
	);
}
