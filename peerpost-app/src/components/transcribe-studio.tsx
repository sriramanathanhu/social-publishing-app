"use client";

import { useEffect, useRef, useState } from "react";

const LANGS = ["Tamil", "English"] as const;
type Lang = (typeof LANGS)[number];

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
	corpusReady,
}: {
	initialJobs: TranscriptJob[];
	corpusReady: boolean;
}) {
	const [jobs, setJobs] = useState<TranscriptJob[]>(initialJobs);
	const [mode, setMode] = useState<"upload" | "drive">("upload");
	const [title, setTitle] = useState("");
	const [audioUrl, setAudioUrl] = useState<string | null>(null);
	const [audioName, setAudioName] = useState("");
	const [driveLink, setDriveLink] = useState("");
	const [chunks, setChunks] = useState(4);
	const [sourceLang, setSourceLang] = useState<Lang>("English");
	const [translate, setTranslate] = useState(false);
	const [outputLang, setOutputLang] = useState<Lang>("English");
	const [uploadBusy, setUploadBusy] = useState(false);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [pushing, setPushing] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Poll any in-flight jobs.
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
					outputLang: translate ? outputLang : sourceLang,
					translate,
				}),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Could not start");
			setJobs((prev) => [d.job, ...prev]);
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

	async function remove(id: string) {
		setJobs((prev) => prev.filter((j) => j.id !== id));
		await fetch(`/api/transcribe/${id}`, { method: "DELETE" }).catch(() => {});
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

	return (
		<div className="space-y-6">
			<header>
				<h1 className="font-bold text-2xl text-slate-900">Transcribe</h1>
				<p className="mt-1 text-slate-500 text-sm">
					Upload audio or paste a Google Drive link → split into chunks → Gemini
					transcribes each (Tamil/English, optional translation) → save and push
					to the corpus for article generation.
				</p>
			</header>

			{/* New job */}
			<div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
				<div className="mb-3 flex gap-2">
					<button
						type="button"
						onClick={() => setMode("upload")}
						className={`rounded-lg px-3 py-1.5 text-sm ${mode === "upload" ? "bg-slate-900 text-white" : "border border-slate-300"}`}
					>
						Upload file
					</button>
					<button
						type="button"
						onClick={() => setMode("drive")}
						className={`rounded-lg px-3 py-1.5 text-sm ${mode === "drive" ? "bg-slate-900 text-white" : "border border-slate-300"}`}
					>
						Google Drive link
					</button>
				</div>

				{mode === "upload" ? (
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
				) : (
					<input
						value={driveLink}
						onChange={(e) => setDriveLink(e.target.value)}
						placeholder="https://drive.google.com/file/d/…  (shared: Anyone with the link)"
						className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
					/>
				)}

				<div className="mt-3 grid gap-3 sm:grid-cols-2">
					<label className="text-sm">
						<span className="mb-1 block text-slate-500 text-xs">Title</span>
						<input
							value={title}
							onChange={(e) => setTitle(e.target.value)}
							placeholder="e.g. Satsang 2025-06-21"
							className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm focus:border-slate-500 focus:outline-none"
						/>
					</label>
					<label className="text-sm">
						<span className="mb-1 block text-slate-500 text-xs">
							Number of chunks
						</span>
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
							Source audio language
						</span>
						<select
							value={sourceLang}
							onChange={(e) => setSourceLang(e.target.value as Lang)}
							className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
						>
							{LANGS.map((l) => (
								<option key={l} value={l}>
									{l}
								</option>
							))}
						</select>
					</label>
					<div className="text-sm">
						<span className="mb-1 block text-slate-500 text-xs">
							Output language
						</span>
						<label className="mb-1 flex items-center gap-2">
							<input
								type="checkbox"
								checked={translate}
								onChange={(e) => setTranslate(e.target.checked)}
							/>
							<span>Translate</span>
						</label>
						{translate && (
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
						)}
					</div>
				</div>

				<div className="mt-3 flex items-center gap-3">
					<button
						type="button"
						onClick={start}
						disabled={busy || uploadBusy}
						className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40"
					>
						{busy ? "Starting…" : "Transcribe"}
					</button>
					{error && <span className="text-red-600 text-sm">{error}</span>}
				</div>
			</div>

			{/* Jobs */}
			<div className="space-y-4">
				{jobs.map((j) => (
					<div
						key={j.id}
						className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="min-w-0">
								<div className="truncate font-medium text-slate-800">
									{j.title}
								</div>
								<div className="text-slate-400 text-xs">
									{j.chunks} chunks · {j.sourceLang}
									{j.translate ? ` → ${j.outputLang}` : ""}
								</div>
							</div>
							<div className="flex items-center gap-2">
								{j.pushedAt ? (
									<span className="rounded bg-green-100 px-2 py-1 text-green-700 text-xs">
										In corpus ✓
									</span>
								) : null}
								<button
									type="button"
									onClick={() => remove(j.id)}
									className="rounded border border-red-200 px-2 py-1 text-red-600 text-xs hover:bg-red-50"
								>
									Delete
								</button>
							</div>
						</div>

						{(j.status === "queued" || j.status === "running") && (
							<div className="mt-3">
								<div className="h-1.5 w-full overflow-hidden rounded bg-slate-100">
									<div
										className="h-full bg-slate-900 transition-all"
										style={{ width: `${j.pct}%` }}
									/>
								</div>
								<div className="mt-1 text-slate-500 text-xs">
									{j.message || j.stage || "Working…"} ({j.pct}%)
								</div>
							</div>
						)}

						{j.status === "failed" && (
							<div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2.5 text-red-700 text-xs">
								{j.error || "Transcription failed."}
							</div>
						)}

						{j.status === "done" && (
							<div className="mt-3">
								<textarea
									value={j.transcript ?? ""}
									onChange={(e) => editTranscript(j.id, e.target.value)}
									className="h-64 w-full resize-y rounded-lg border border-slate-300 p-3 text-sm focus:border-slate-500 focus:outline-none"
								/>
								<div className="mt-2 flex flex-wrap items-center gap-2">
									<button
										type="button"
										onClick={() => push(j.id)}
										disabled={pushing === j.id || !corpusReady}
										title={
											corpusReady
												? ""
												: "Corpus (GCS + Vertex) isn't configured"
										}
										className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-40"
									>
										{pushing === j.id
											? "Pushing…"
											: j.pushedAt
												? "Re-push to corpus"
												: "Push to corpus"}
									</button>
									<button
										type="button"
										onClick={() =>
											navigator.clipboard.writeText(j.transcript ?? "")
										}
										className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-50"
									>
										Copy
									</button>
									{j.pushedAt && (
										<span className="text-slate-400 text-xs">
											Pushed — indexing in Vertex can take a few minutes.
										</span>
									)}
								</div>
							</div>
						)}
					</div>
				))}
				{jobs.length === 0 && (
					<p className="text-slate-400 text-sm">No transcriptions yet.</p>
				)}
			</div>
		</div>
	);
}
