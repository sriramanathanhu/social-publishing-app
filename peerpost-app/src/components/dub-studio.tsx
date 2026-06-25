"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DUB_LANGUAGES } from "@/lib/dub-options";

type Progress = { pct: number; stage: string; message: string };

/** Compose a dub job and stream its progress over SSE. Publishing happens from
 * the DubTable below, which re-renders when this calls router.refresh(). */
export function DubStudio({
	libraryVideos = [],
	ecosystems = [],
}: {
	libraryVideos?: {
		id: string;
		title: string;
		url: string;
		kind: "upload" | "short";
	}[];
	ecosystems?: { id: string; name: string; teamName: string }[];
}) {
	const router = useRouter();
	const [tab, setTab] = useState<"url" | "upload" | "library">("url");
	const [url, setUrl] = useState("");
	const [libraryId, setLibraryId] = useState(libraryVideos[0]?.id ?? "");
	const [file, setFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [langCode, setLangCode] = useState(DUB_LANGUAGES[0].code);
	const [voice, setVoice] = useState(DUB_LANGUAGES[0].voices[0].id);
	const [sourceLang, setSourceLang] = useState("auto");
	const [burnCaptions, setBurnCaptions] = useState(false);
	const [autoPublish, setAutoPublish] = useState(false);
	const [autoEcoId, setAutoEcoId] = useState(ecosystems[0]?.id ?? "");

	const [jobId, setJobId] = useState<string | null>(null);
	const [progress, setProgress] = useState<Progress | null>(null);
	const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);
	const esRef = useRef<EventSource | null>(null);

	const language = DUB_LANGUAGES.find((l) => l.code === langCode);

	// Tear down the SSE connection on unmount.
	useEffect(() => () => esRef.current?.close(), []);

	// Force the server to poll the dubber-service and persist the row's terminal
	// state. Best-effort: a failure just leaves the next page load to reconcile.
	async function syncStatus(id: string) {
		try {
			await fetch(`/api/dub/${id}`);
		} catch {
			/* ignore — router.refresh() will re-read the row */
		}
	}

	function subscribe(id: string) {
		esRef.current?.close();
		const es = new EventSource(`/api/dub/${id}/events`);
		esRef.current = es;
		es.addEventListener("progress", (e) => {
			try {
				const d = JSON.parse((e as MessageEvent).data);
				setProgress({ pct: d.pct, stage: d.stage, message: d.message });
			} catch {
				/* ignore malformed frame */
			}
		});
		es.addEventListener("done", async () => {
			setPhase("done");
			setProgress((p) =>
				p ? { ...p, pct: 100 } : { pct: 100, stage: "done", message: "Done" },
			);
			es.close();
			// The SSE proxy only streams to the browser — it doesn't write the DB.
			// Hit the status route so the row is persisted as "done"; otherwise
			// /result and /export (which check the stored row) keep returning
			// "Dub is not finished yet" and the option vanishes on reload.
			await syncStatus(id);
			router.refresh();
		});
		es.addEventListener("failed", async (e) => {
			setPhase("failed");
			setError((e as MessageEvent).data || "Dub failed");
			es.close();
			await syncStatus(id);
			router.refresh();
		});
		es.onerror = () => es.close();
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setProgress(null);
		try {
			let sourceType: "url" | "upload" = "url";
			let sourceInput = url;
			let sourceLibraryId: string | undefined;
			let sourceLibraryKind: "upload" | "short" | undefined;

			// Library tab: a video we already host (R2 public URL) — fetch directly.
			if (tab === "library") {
				const v = libraryVideos.find((x) => x.id === libraryId);
				if (!v) throw new Error("Pick a video from your library.");
				sourceType = "upload";
				sourceInput = v.url;
				sourceLibraryId = v.id;
				sourceLibraryKind = v.kind;
			}

			// Upload tab: push the local file to our media store first, then dub the
			// resulting public URL. Avoids cookies entirely (we host the file).
			if (tab === "upload") {
				if (!file) throw new Error("Choose a video file to upload.");
				setUploading(true);
				const fd = new FormData();
				fd.append("file", file);
				const up = await fetch("/api/media/upload", {
					method: "POST",
					body: fd,
				});
				const upd = await up.json();
				setUploading(false);
				if (!up.ok) throw new Error(upd.error ?? "Upload failed");
				sourceType = "upload";
				sourceInput = upd.publicUrl;
			}

			setPhase("running");
			const res = await fetch("/api/dub", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceType,
					sourceInput,
					sourceLang,
					targetLang: langCode,
					voice,
					burnCaptions,
					autoPublishProfileId:
						autoPublish && autoEcoId ? autoEcoId : undefined,
					sourceLibraryId,
					sourceLibraryKind,
				}),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Failed to start dub");
			setJobId(d.job.id);
			subscribe(d.job.id);
		} catch (err) {
			setUploading(false);
			setPhase("failed");
			setError(err instanceof Error ? err.message : "Error");
		}
	}

	const running = phase === "running" || uploading;

	return (
		<div className="space-y-6">
			<form
				onSubmit={submit}
				className="space-y-4 rounded-lg border border-black/10 p-4"
			>
				<div>
					{/* Source tabs: a remote URL (yt-dlp) or a local file upload. */}
					<div className="mb-3 inline-flex rounded-md border border-black/15 p-0.5 text-sm">
						<button
							type="button"
							onClick={() => setTab("url")}
							className={`rounded px-3 py-1 ${tab === "url" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
						>
							URL
						</button>
						<button
							type="button"
							onClick={() => setTab("upload")}
							className={`rounded px-3 py-1 ${tab === "upload" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
						>
							Upload from local system
						</button>
						<button
							type="button"
							onClick={() => setTab("library")}
							className={`rounded px-3 py-1 ${tab === "library" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
						>
							From Library
						</button>
					</div>

					{tab === "library" ? (
						<>
							<label className="mb-1 block text-xs font-medium opacity-60">
								Video from your Library
							</label>
							{libraryVideos.length === 0 ? (
								<p className="text-xs opacity-50">
									No videos in your Library yet — upload one under Library →
									Video, or generate shorts.
								</p>
							) : (
								<select
									value={libraryId}
									onChange={(e) => setLibraryId(e.target.value)}
									className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
								>
									{libraryVideos.map((v) => (
										<option key={v.id} value={v.id}>
											{v.title}
										</option>
									))}
								</select>
							)}
							<p className="mt-1 text-xs opacity-50">
								Uploaded videos and generated shorts from your Library.
							</p>
						</>
					) : tab === "url" ? (
						<>
							<label className="mb-1 block text-xs font-medium opacity-60">
								Video URL (YouTube / Instagram / Google Drive link)
							</label>
							<input
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								required={tab === "url"}
								type="url"
								placeholder="https://www.youtube.com/watch?v=…"
								className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
							/>
							<p className="mt-1 text-xs opacity-50">
								Login/rate-limited sources (Instagram, YouTube) may need cookies
								— add them under Settings → Service keys.
							</p>
						</>
					) : (
						<>
							<label className="mb-1 block text-xs font-medium opacity-60">
								Video file
							</label>
							<input
								type="file"
								accept="video/*"
								onChange={(e) => setFile(e.target.files?.[0] ?? null)}
								required={tab === "upload"}
								className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
							/>
							<p className="mt-1 text-xs opacity-50">
								{file
									? `${file.name} (${(file.size / (1024 * 1024)).toFixed(1)} MB)`
									: "Max 200 MB. No cookies needed — we host the file for dubbing."}
							</p>
						</>
					)}
				</div>

				<div className="grid gap-4 sm:grid-cols-3">
					<div>
						<label className="mb-1 block text-xs font-medium opacity-60">
							Source language
						</label>
						<select
							value={sourceLang}
							onChange={(e) => setSourceLang(e.target.value)}
							className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						>
							<option value="auto">Auto-detect</option>
							<option value="en">English</option>
							{DUB_LANGUAGES.map((l) => (
								<option key={l.code} value={l.code}>
									{l.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label className="mb-1 block text-xs font-medium opacity-60">
							Dub into
						</label>
						<select
							value={langCode}
							onChange={(e) => {
								const code = e.target.value;
								setLangCode(code);
								const lang = DUB_LANGUAGES.find((l) => l.code === code);
								if (lang) setVoice(lang.voices[0].id);
							}}
							className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						>
							{DUB_LANGUAGES.map((l) => (
								<option key={l.code} value={l.code}>
									{l.label}
								</option>
							))}
						</select>
					</div>
					<div>
						<label className="mb-1 block text-xs font-medium opacity-60">
							Voice
						</label>
						<select
							value={voice}
							onChange={(e) => setVoice(e.target.value)}
							className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						>
							{language?.voices.map((v) => (
								<option key={v.id} value={v.id}>
									{v.label}
								</option>
							))}
						</select>
					</div>
				</div>

				<label className="flex items-start gap-2 text-sm">
					<input
						type="checkbox"
						checked={burnCaptions}
						onChange={(e) => setBurnCaptions(e.target.checked)}
						className="mt-0.5"
					/>
					<span>
						Burn captions into the video
						<span className="block text-xs opacity-50">
							Adds subtitles in the dub language, baked onto the frames — for
							source videos that have no captions.
						</span>
					</span>
				</label>

				{ecosystems.length > 0 && (
					<label className="flex items-start gap-2 text-sm">
						<input
							type="checkbox"
							checked={autoPublish}
							onChange={(e) => setAutoPublish(e.target.checked)}
							className="mt-0.5"
						/>
						<span className="flex-1">
							Auto-publish when done
							<span className="block text-xs opacity-50">
								Schedules the finished dub to the accounts mapped for{" "}
								{DUB_LANGUAGES.find((l) => l.code === langCode)?.label ??
									langCode}{" "}
								under the chosen ecosystem’s rules.
							</span>
							{autoPublish && (
								<select
									value={autoEcoId}
									onChange={(e) => setAutoEcoId(e.target.value)}
									className="mt-1 block rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
								>
									{ecosystems.map((e) => (
										<option key={e.id} value={e.id}>
											{e.teamName} › {e.name}
										</option>
									))}
								</select>
							)}
						</span>
					</label>
				)}

				<button
					type="submit"
					disabled={running}
					className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
				>
					{uploading ? "Uploading…" : running ? "Dubbing…" : "Run dub"}
				</button>
			</form>

			{(progress || phase !== "idle") && (
				<div className="rounded-lg border border-black/10 p-4">
					<div className="mb-2 flex items-center justify-between text-sm">
						<span className="font-medium">
							{phase === "done"
								? "Completed"
								: phase === "failed"
									? "Failed"
									: (progress?.stage ?? "Starting…")}
						</span>
						<span className="opacity-60">{progress?.pct ?? 0}%</span>
					</div>
					<div className="h-2 w-full overflow-hidden rounded-full bg-black/10">
						<div
							className={`h-full transition-all ${phase === "failed" ? "bg-red-500" : "bg-primary"}`}
							style={{ width: `${progress?.pct ?? 0}%` }}
						/>
					</div>
					{progress?.message && (
						<p className="mt-2 text-xs opacity-60">{progress.message}</p>
					)}
					{error && <p className="mt-2 text-sm text-red-600">{error}</p>}
					{phase === "done" && jobId && (
						<div className="mt-3 flex flex-wrap items-center gap-3">
							<a
								href={`/api/dub/${jobId}/result`}
								className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5"
							>
								Download dubbed video
							</a>
							<span className="text-xs opacity-60">
								Publish it from the table below ↓
							</span>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
