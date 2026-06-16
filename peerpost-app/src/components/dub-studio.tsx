"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { DUB_LANGUAGES } from "@/lib/dub-options";

type DubJobRow = {
	id: string;
	status: string;
	pct: number;
	stage: string | null;
	message: string | null;
	sourceInput: string;
	targetLang: string;
	error: string | null;
	createdAt: string | Date;
};

type Progress = { pct: number; stage: string; message: string };

/** Compose a dub job and stream its progress over SSE. */
export function DubStudio({ recentJobs }: { recentJobs: DubJobRow[] }) {
	const router = useRouter();
	const [tab, setTab] = useState<"url" | "upload">("url");
	const [url, setUrl] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [langCode, setLangCode] = useState(DUB_LANGUAGES[0].code);
	const [voice, setVoice] = useState(DUB_LANGUAGES[0].voices[0].id);
	const [sourceLang, setSourceLang] = useState("auto");

	const [jobId, setJobId] = useState<string | null>(null);
	const [progress, setProgress] = useState<Progress | null>(null);
	const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);
	const [exportingId, setExportingId] = useState<string | null>(null);
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

	// Move a finished dub into PostPeer media, then hand it to the composer.
	async function publish(id: string) {
		setExportingId(id);
		setError(null);
		try {
			const res = await fetch(`/api/dub/${id}/export`, { method: "POST" });
			const d = await res.json();
			if (!res.ok)
				throw new Error(d.error ?? "Failed to prepare for publishing");
			router.push(`/publishing/create?dub=${id}`);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
			setExportingId(null);
		}
	}

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
					</div>

					{tab === "url" ? (
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
						<div className="mt-3 flex flex-wrap gap-2">
							<button
								type="button"
								onClick={() => publish(jobId)}
								disabled={exportingId === jobId}
								className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
							>
								{exportingId === jobId ? "Preparing…" : "Publish to social"}
							</button>
							<a
								href={`/api/dub/${jobId}/result`}
								className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5"
							>
								Download dubbed video
							</a>
						</div>
					)}
				</div>
			)}

			{recentJobs.length > 0 && (
				<div>
					<h2 className="mb-2 text-sm font-semibold opacity-70">Recent jobs</h2>
					<div className="divide-y divide-black/5 rounded-lg border border-black/10">
						{recentJobs.map((j) => (
							<div
								key={j.id}
								className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
							>
								<div className="min-w-0">
									<div className="truncate">{j.sourceInput}</div>
									<div className="text-xs opacity-50">
										→ {j.targetLang} · {new Date(j.createdAt).toLocaleString()}
									</div>
								</div>
								<div className="flex shrink-0 items-center gap-3">
									<StatusBadge status={j.status} />
									{j.status === "done" && (
										<>
											<button
												type="button"
												onClick={() => publish(j.id)}
												disabled={exportingId === j.id}
												className="text-xs font-medium text-primary disabled:opacity-50"
											>
												{exportingId === j.id ? "Preparing…" : "Publish"}
											</button>
											<a
												href={`/api/dub/${j.id}/result`}
												className="text-xs underline opacity-70 hover:opacity-100"
											>
												Download
											</a>
										</>
									)}
								</div>
							</div>
						))}
					</div>
				</div>
			)}
		</div>
	);
}

function StatusBadge({ status }: { status: string }) {
	const styles: Record<string, string> = {
		done: "bg-green-100 text-green-700",
		failed: "bg-red-100 text-red-700",
		running: "bg-blue-100 text-blue-700",
		queued: "bg-black/10 text-black/60",
		awaiting_review: "bg-amber-100 text-amber-700",
	};
	return (
		<span
			className={`rounded px-1.5 py-0.5 text-xs ${styles[status] ?? "bg-black/10"}`}
		>
			{status}
		</span>
	);
}
