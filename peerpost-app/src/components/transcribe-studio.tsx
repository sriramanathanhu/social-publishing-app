"use client";

import { useEffect, useRef, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";
import { RichEditor } from "@/components/rich-editor";
import { TextAutoSchedule } from "@/components/text-auto-schedule";
import { TextAutopublishRules } from "@/components/text-autopublish-rules";
import { DUB_LANGUAGES } from "@/lib/dub-options";

const LANGS = ["Tamil", "English"] as const;
type Lang = (typeof LANGS)[number];
// Source language: "Auto-detect" transcribes every language as spoken (native
// script); a specific language is just a hint (code-switching still preserved).
const SOURCE_LANGS = ["Auto-detect", "English", "Tamil"] as const;
type SourceLang = (typeof SOURCE_LANGS)[number];

// Translate a finished transcript into any of these (the same 15 as dubbing).
const TRANSLATE_LANGS = DUB_LANGUAGES.map((l) => l.label);

export type TranscriptJob = {
	id: string;
	title: string;
	sourceType: string;
	chunks: number;
	sourceLang: string;
	outputLang: string;
	translate: boolean;
	status: "queued" | "running" | "done" | "failed" | "awaiting_review";
	pct: number;
	stage: string | null;
	message: string | null;
	transcript: string | null;
	error: string | null;
	corpusKey: string | null;
	pushedAt: string | Date | null;
	createdAt: string | Date;
};

export function TranscribeStudio({
	initialJobs,
	ecosystems,
	corpusReady,
}: {
	initialJobs: TranscriptJob[];
	ecosystems: Ecosystem[];
	corpusReady: boolean;
}) {
	const [jobs, setJobs] = useState<TranscriptJob[]>(initialJobs);
	const [selectedId, setSelectedId] = useState<string | null>(
		initialJobs[0]?.id ?? null,
	);
	const [mergeSet, setMergeSet] = useState<Set<string>>(new Set());
	const [showAdd, setShowAdd] = useState(initialJobs.length === 0);

	const [mode, setMode] = useState<"upload" | "drive">("drive");
	const [title, setTitle] = useState("");
	const [audioUrl, setAudioUrl] = useState<string | null>(null);
	const [audioName, setAudioName] = useState("");
	const [driveLink, setDriveLink] = useState("");
	const [chunks, setChunks] = useState(1);
	const [sourceLang, setSourceLang] = useState<SourceLang>("Auto-detect");
	const [translate, setTranslate] = useState(false);
	const [outputLang, setOutputLang] = useState<Lang>("English");

	const [uploadBusy, setUploadBusy] = useState(false);
	const [busy, setBusy] = useState(false);
	const [merging, setMerging] = useState(false);
	const [pushing, setPushing] = useState<string | null>(null);
	const [translating, setTranslating] = useState<string | null>(null);
	const [transLang, setTransLang] = useState(TRANSLATE_LANGS[0]);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const selected = jobs.find((j) => j.id === selectedId) ?? null;

	// Poll in-flight jobs.
	useEffect(() => {
		const active = jobs.some(
			(j) => j.status === "queued" || j.status === "running",
		);
		if (!active) return;
		const iv = setInterval(async () => {
			const running = jobs.filter(
				(j) => j.status === "queued" || j.status === "running",
			);
			for (const j of running) {
				try {
					const res = await fetch(`/api/transcribe/${j.id}`);
					const d = await res.json();
					if (d.job)
						setJobs((prev) => prev.map((x) => (x.id === j.id ? d.job : x)));
				} catch {
					// keep polling
				}
			}
		}, 3000);
		return () => clearInterval(iv);
	}, [jobs]);

	async function uploadAudio(file: File) {
		setUploadBusy(true);
		setError(null);
		try {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch("/api/transcribe/upload", {
				method: "POST",
				body: fd,
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Upload failed");
			setAudioUrl(d.url);
			setAudioName(file.name);
			if (!title) setTitle(file.name.replace(/\.[^.]+$/, ""));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Upload failed");
		} finally {
			setUploadBusy(false);
		}
	}

	async function start() {
		const sourceInput = mode === "upload" ? audioUrl : driveLink.trim();
		if (!sourceInput) {
			setError(
				mode === "upload"
					? "Upload an audio file first."
					: "Paste a Drive link.",
			);
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/transcribe", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					title: title.trim() || undefined,
					sourceType: mode,
					sourceInput,
					chunks,
					sourceLang,
					// outputLang only matters when translating; otherwise send a
					// valid LANGS value (the sidecar ignores it for transcription).
					outputLang: translate ? outputLang : "English",
					translate,
				}),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Could not start");
			setJobs((prev) => [d.job, ...prev]);
			setSelectedId(d.job.id);
			setAudioUrl(null);
			setAudioName("");
			setDriveLink("");
			setTitle("");
		} catch (e) {
			setError(e instanceof Error ? e.message : "Could not start");
		} finally {
			setBusy(false);
		}
	}

	function editTranscript(id: string, value: string) {
		setJobs((prev) =>
			prev.map((j) => (j.id === id ? { ...j, transcript: value } : j)),
		);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			fetch(`/api/transcribe/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ transcript: value }),
			}).catch(() => {});
		}, 800);
	}

	function editTitle(id: string, value: string) {
		setJobs((prev) =>
			prev.map((j) => (j.id === id ? { ...j, title: value } : j)),
		);
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			fetch(`/api/transcribe/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: value }),
			}).catch(() => {});
		}, 800);
	}

	async function remove(id: string) {
		setJobs((prev) => prev.filter((j) => j.id !== id));
		if (selectedId === id) setSelectedId(null);
		setMergeSet((prev) => {
			const n = new Set(prev);
			n.delete(id);
			return n;
		});
		await fetch(`/api/transcribe/${id}`, { method: "DELETE" }).catch(() => {});
	}

	function toggleMerge(id: string) {
		setMergeSet((prev) => {
			const n = new Set(prev);
			if (n.has(id)) n.delete(id);
			else n.add(id);
			return n;
		});
	}

	async function mergeSelected() {
		if (mergeSet.size < 2) return;
		setMerging(true);
		setError(null);
		try {
			const res = await fetch("/api/transcribe/merge", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ ids: [...mergeSet] }),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Merge failed");
			setJobs((prev) => [d.job, ...prev]);
			setSelectedId(d.job.id);
			setMergeSet(new Set());
		} catch (e) {
			setError(e instanceof Error ? e.message : "Merge failed");
		} finally {
			setMerging(false);
		}
	}

	async function push(id: string) {
		setPushing(id);
		setError(null);
		try {
			const res = await fetch(`/api/transcribe/${id}/push`, { method: "POST" });
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Push failed");
			setJobs((prev) => prev.map((j) => (j.id === id ? d.job : j)));
		} catch (e) {
			setError(e instanceof Error ? e.message : "Push failed");
		} finally {
			setPushing(null);
		}
	}

	async function translateTo(id: string, lang: string) {
		setTranslating(id);
		setError(null);
		try {
			const res = await fetch(`/api/transcribe/${id}/translate`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ lang }),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Translation failed");
			setJobs((prev) => [d.job, ...prev]);
			setSelectedId(d.job.id);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Translation failed");
		} finally {
			setTranslating(null);
		}
	}

	return (
		<div className="flex h-full flex-col">
			<div className="border-slate-200 border-b px-6 py-2">
				<TextAutopublishRules ecosystems={ecosystems} kind="transcript" />
			</div>
			{/* Header */}
			<div className="flex items-center justify-between gap-4 border-slate-200 border-b px-6 py-3">
				<div>
					<h1 className="font-bold text-slate-900 text-xl">Transcribe</h1>
					<p className="text-slate-500 text-xs">
						Add each live chunk (Drive link) as it arrives, edit, then merge all
						into one transcript and push to the corpus.
					</p>
				</div>
				<button
					type="button"
					onClick={() => setShowAdd((v) => !v)}
					className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white"
				>
					{showAdd ? "Close" : "+ Add chunk"}
				</button>
			</div>

			{/* Add chunk (collapsible) */}
			{showAdd && (
				<div className="border-slate-200 border-b bg-slate-50 px-6 py-4">
					<div className="mb-3 flex gap-2">
						<button
							type="button"
							onClick={() => setMode("drive")}
							className={`rounded-lg px-3 py-1.5 text-sm ${mode === "drive" ? "bg-slate-900 text-white" : "border border-slate-300"}`}
						>
							Google Drive link
						</button>
						<button
							type="button"
							onClick={() => setMode("upload")}
							className={`rounded-lg px-3 py-1.5 text-sm ${mode === "upload" ? "bg-slate-900 text-white" : "border border-slate-300"}`}
						>
							Upload file
						</button>
					</div>

					{mode === "drive" ? (
						<input
							value={driveLink}
							onChange={(e) => setDriveLink(e.target.value)}
							placeholder="https://drive.google.com/file/d/…  (shared: Anyone with the link)"
							className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
						/>
					) : (
						<div className="flex items-center gap-3">
							<button
								type="button"
								onClick={() => fileRef.current?.click()}
								disabled={uploadBusy}
								className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
							>
								{uploadBusy ? "Uploading…" : "Choose audio file"}
							</button>
							{audioName && (
								<span className="text-slate-500 text-sm">{audioName}</span>
							)}
							<input
								ref={fileRef}
								type="file"
								accept="audio/*,video/*"
								className="hidden"
								onChange={(e) => {
									const f = e.target.files?.[0];
									if (f) uploadAudio(f);
									e.target.value = "";
								}}
							/>
						</div>
					)}

					<div className="mt-3 grid gap-3 sm:grid-cols-4">
						<label className="text-sm sm:col-span-2">
							<span className="mb-1 block text-slate-500 text-xs">Title</span>
							<input
								value={title}
								onChange={(e) => setTitle(e.target.value)}
								placeholder="e.g. Live — part 3"
								className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
							/>
						</label>
						<label className="text-sm">
							<span className="mb-1 block text-slate-500 text-xs">Chunks</span>
							<input
								type="number"
								min={1}
								max={50}
								value={chunks}
								onChange={(e) =>
									setChunks(
										Math.max(1, Math.min(50, Number(e.target.value) || 1)),
									)
								}
								className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
							/>
						</label>
						<label className="text-sm">
							<span className="mb-1 block text-slate-500 text-xs">
								Audio language
							</span>
							<select
								value={sourceLang}
								onChange={(e) => setSourceLang(e.target.value as SourceLang)}
								className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
							>
								{SOURCE_LANGS.map((l) => (
									<option key={l} value={l}>
										{l === "Auto-detect" ? "Auto-detect (multi-language)" : l}
									</option>
								))}
							</select>
						</label>
						<label className="flex items-center gap-2 text-sm">
							<input
								type="checkbox"
								checked={translate}
								onChange={(e) => setTranslate(e.target.checked)}
							/>
							<span>Translate</span>
						</label>
						{translate && (
							<label className="text-sm">
								<span className="mb-1 block text-slate-500 text-xs">
									Output language
								</span>
								<select
									value={outputLang}
									onChange={(e) => setOutputLang(e.target.value as Lang)}
									className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
								>
									{LANGS.map((l) => (
										<option key={l} value={l}>
											{l}
										</option>
									))}
								</select>
							</label>
						)}
					</div>

					<div className="mt-3 flex items-center gap-3">
						<button
							type="button"
							onClick={start}
							disabled={busy || uploadBusy}
							className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40"
						>
							{busy ? "Starting…" : "Transcribe chunk"}
						</button>
						{error && <span className="text-red-600 text-sm">{error}</span>}
					</div>
				</div>
			)}

			{/* Merge bar */}
			{mergeSet.size >= 2 && (
				<div className="flex items-center gap-3 border-slate-200 border-b bg-amber-50 px-6 py-2">
					<span className="text-amber-800 text-sm">
						{mergeSet.size} selected
					</span>
					<button
						type="button"
						onClick={mergeSelected}
						disabled={merging}
						className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-40"
					>
						{merging ? "Merging…" : "Merge selected (chunk order)"}
					</button>
					<button
						type="button"
						onClick={() => setMergeSet(new Set())}
						className="text-slate-500 text-sm hover:text-slate-700"
					>
						Clear
					</button>
				</div>
			)}

			{/* Split: list + editor */}
			<div className="flex min-h-0 flex-1">
				<aside className="w-64 shrink-0 overflow-y-auto border-slate-200 border-r">
					<div className="px-3 py-2 font-medium text-slate-400 text-xs uppercase tracking-wide">
						{jobs.length} item{jobs.length === 1 ? "" : "s"}
					</div>
					{jobs.map((j) => (
						<div
							key={j.id}
							className={`flex items-center gap-2 border-slate-100 border-b px-2 py-2 ${
								j.id === selectedId ? "bg-slate-100" : "hover:bg-slate-50"
							}`}
						>
							{j.status === "done" && (
								<input
									type="checkbox"
									checked={mergeSet.has(j.id)}
									onChange={() => toggleMerge(j.id)}
									title="Select to merge"
									className="shrink-0"
								/>
							)}
							<button
								type="button"
								onClick={() => setSelectedId(j.id)}
								className="min-w-0 flex-1 text-left"
							>
								<div className="truncate text-slate-800 text-sm">{j.title}</div>
								<div className="flex items-center gap-1 text-xs">
									{j.sourceType === "merged" && (
										<span className="rounded bg-indigo-100 px-1 text-[10px] text-indigo-700">
											merged
										</span>
									)}
									<span
										className={
											j.status === "failed"
												? "text-red-500"
												: j.status === "done"
													? "text-slate-400"
													: "text-amber-600"
										}
									>
										{j.status === "running" || j.status === "queued"
											? `${j.pct}%`
											: j.status}
									</span>
									{j.pushedAt && (
										<span className="text-green-600">· in corpus</span>
									)}
								</div>
							</button>
						</div>
					))}
					{jobs.length === 0 && (
						<p className="px-3 py-2 text-slate-400 text-sm">No chunks yet.</p>
					)}
				</aside>

				<main className="min-w-0 flex-1 overflow-y-auto">
					{selected ? (
						<div className="px-8 py-6">
							{selected.status === "done" && selected.transcript && (
								<div className="mb-4">
									<TextAutoSchedule kind="transcript" itemId={selected.id} />
								</div>
							)}
							<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
								<input
									value={selected.title}
									onChange={(e) => editTitle(selected.id, e.target.value)}
									className="min-w-0 flex-1 rounded-lg border border-transparent px-1 py-1 font-bold text-slate-900 text-xl hover:border-slate-200 focus:border-slate-300 focus:outline-none"
								/>
								<div className="flex items-center gap-2 text-xs">
									<span className="text-slate-400">
										{selected.sourceType === "merged"
											? `${selected.chunks} chunks`
											: `${selected.sourceLang}${selected.translate ? ` → ${selected.outputLang}` : ""}`}
									</span>
									<button
										type="button"
										onClick={() =>
											navigator.clipboard.writeText(selected.transcript ?? "")
										}
										className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
									>
										Copy
									</button>
									<button
										type="button"
										onClick={() => remove(selected.id)}
										className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"
									>
										Delete
									</button>
								</div>
							</div>

							{(selected.status === "queued" ||
								selected.status === "running") && (
								<div className="mt-3">
									<div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
										<div
											className="h-full bg-slate-900 transition-all"
											style={{ width: `${selected.pct}%` }}
										/>
									</div>
									<div className="mt-1 text-slate-500 text-xs">
										{selected.message || selected.stage || "Working…"} (
										{selected.pct}%)
									</div>
								</div>
							)}

							{selected.status === "failed" && (
								<div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-700 text-sm">
									{selected.error || "Transcription failed."}
								</div>
							)}

							{selected.status === "done" && (
								<>
									<RichEditor
										key={selected.id}
										markdown={selected.transcript ?? ""}
										onChange={(md) => editTranscript(selected.id, md)}
									/>
									<div className="mt-3 flex flex-wrap items-center gap-2">
										<button
											type="button"
											onClick={() => push(selected.id)}
											disabled={pushing === selected.id || !corpusReady}
											title={
												corpusReady
													? ""
													: "Corpus (GCS + Vertex) isn't configured"
											}
											className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-40"
										>
											{pushing === selected.id
												? "Pushing…"
												: selected.pushedAt
													? "Re-push to corpus"
													: "Push to corpus"}
										</button>
										<span className="mx-1 h-5 w-px bg-slate-200" />
										<select
											value={transLang}
											onChange={(e) => setTransLang(e.target.value)}
											disabled={translating === selected.id}
											className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm"
											title="Translate this transcript into…"
										>
											{TRANSLATE_LANGS.map((l) => (
												<option key={l} value={l}>
													{l}
												</option>
											))}
										</select>
										<button
											type="button"
											onClick={() => translateTo(selected.id, transLang)}
											disabled={translating === selected.id}
											className="rounded-lg border border-slate-300 px-3 py-1.5 font-medium text-sm hover:bg-slate-50 disabled:opacity-40"
										>
											{translating === selected.id
												? "Translating…"
												: "Translate → new transcript"}
										</button>
										{selected.pushedAt && (
											<span className="text-slate-400 text-xs">
												Pushed — Vertex indexing can take a few minutes.
											</span>
										)}
										{error && (
											<span className="text-red-600 text-sm">{error}</span>
										)}
									</div>
								</>
							)}
						</div>
					) : (
						<div className="flex h-full items-center justify-center p-10 text-center text-slate-400 text-sm">
							Add a chunk, or pick one from the list to edit.
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
