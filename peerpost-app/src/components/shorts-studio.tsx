"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { uploadMedia } from "@/lib/upload-media";

type Progress = { pct: number; stage: string; message: string };

const NUM =
	"mt-1 w-full rounded-md border border-black/15 px-2.5 py-1.5 text-sm";
const LBL = "block text-xs font-medium opacity-60";

/** Compose a shorts job and stream its progress. Clips are published from the
 * ShortsTable below, which re-renders when this calls router.refresh(). */
export function ShortsStudio() {
	const router = useRouter();
	const [name, setName] = useState("");
	// Source: a remote URL (yt-dlp) or a local file we upload to object storage.
	const [tab, setTab] = useState<"url" | "upload">("url");
	const [url, setUrl] = useState("");
	const [file, setFile] = useState<File | null>(null);
	const [uploading, setUploading] = useState(false);
	const [numClips, setNumClips] = useState(2);
	const [minSeconds, setMinSeconds] = useState(150);
	const [maxSeconds, setMaxSeconds] = useState(180);
	const [aspect, setAspect] = useState("9:16");
	const [cropFocus, setCropFocus] = useState<
		"auto" | "center" | "left" | "right"
	>("auto");
	const [speed, setSpeed] = useState(1.5);
	const [captions, setCaptions] = useState(true);
	const [selector, setSelector] = useState<"gemini" | "nim">("nim");
	// Optional: spread the finished clips into a saved shorts target list.
	const [distributions, setDistributions] = useState<
		{
			id: string;
			name: string;
			shortsPerTarget: number;
			targets: { profileId: string }[];
		}[]
	>([]);
	const [distId, setDistId] = useState("");
	// Optional reference face: when set (and Focus = Auto), the reframer tracks
	// this specific person across clips instead of whoever's face is largest.
	const [referenceFaceUrl, setReferenceFaceUrl] = useState<string | null>(null);
	const [uploadingFace, setUploadingFace] = useState(false);
	const [faceError, setFaceError] = useState<string | null>(null);

	useEffect(() => {
		const load = () =>
			fetch("/api/shorts/distributions")
				.then((r) => r.json())
				.then((d) => setDistributions(d.distributions ?? []))
				.catch(() => {});
		load();
		window.addEventListener("focus", load);
		window.addEventListener("shorts:distributions-changed", load);
		return () => {
			window.removeEventListener("focus", load);
			window.removeEventListener("shorts:distributions-changed", load);
		};
	}, []);

	const [progress, setProgress] = useState<Progress | null>(null);
	const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);
	const esRef = useRef<EventSource | null>(null);
	const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

	useEffect(
		() => () => {
			esRef.current?.close();
			if (pollRef.current) clearInterval(pollRef.current);
		},
		[],
	);

	function stopWatching() {
		esRef.current?.close();
		if (pollRef.current) clearInterval(pollRef.current);
	}

	async function syncStatus(id: string) {
		try {
			await fetch(`/api/shorts/${id}`);
		} catch {
			/* the refresh re-reads the row */
		}
	}

	// Poll the status as a safety net: the SSE connection is often cut by the
	// gateway on long jobs, so the "done" event never arrives and the row would
	// otherwise stay "running" until a manual refresh. Polling the status route
	// (which syncs from the sidecar) catches completion reliably.
	function startPolling(id: string) {
		if (pollRef.current) clearInterval(pollRef.current);
		pollRef.current = setInterval(async () => {
			try {
				const r = await fetch(`/api/shorts/${id}`);
				const d = await r.json();
				const j = d?.job;
				if (!j) return;
				setProgress((p) => ({
					pct: j.pct ?? p?.pct ?? 0,
					stage: j.stage ?? p?.stage ?? "",
					message: j.message ?? p?.message ?? "",
				}));
				if (j.status === "done" || j.status === "failed") {
					stopWatching();
					setPhase(j.status);
					if (j.status === "failed") setError(j.error || "Shorts job failed");
					else setProgress((p) => (p ? { ...p, pct: 100 } : null));
					router.refresh();
				}
			} catch {
				/* keep polling */
			}
		}, 5000);
	}

	function subscribe(id: string) {
		esRef.current?.close();
		const es = new EventSource(`/api/shorts/${id}/events`);
		esRef.current = es;
		es.addEventListener("progress", (e) => {
			try {
				const d = JSON.parse((e as MessageEvent).data);
				setProgress({ pct: d.pct, stage: d.stage, message: d.message });
			} catch {
				/* ignore */
			}
		});
		es.addEventListener("done", async () => {
			stopWatching();
			setPhase("done");
			setProgress((p) => (p ? { ...p, pct: 100 } : null));
			await syncStatus(id);
			router.refresh();
		});
		es.addEventListener("failed", async (e) => {
			stopWatching();
			setPhase("failed");
			setError((e as MessageEvent).data || "Shorts job failed");
			await syncStatus(id);
			router.refresh();
		});
		// If the gateway cuts the SSE stream, the poll below still catches the end.
		es.onerror = () => es.close();
		startPolling(id);
	}

	// Upload a reference face to object storage (same path as overlay assets) and
	// keep the returned public URL to send with the job.
	async function uploadFace(file: File) {
		setFaceError(null);
		setUploadingFace(true);
		try {
			setReferenceFaceUrl(await uploadMedia(file));
		} catch (err) {
			setFaceError(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploadingFace(false);
		}
	}

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setError(null);
		setProgress(null);
		try {
			// Upload tab: push the local file to our media store first, then generate
			// shorts from the resulting public URL (no cookies — we host the file).
			let sourceType: "url" | "upload" = "url";
			let sourceInput = url;
			if (tab === "upload") {
				if (!file) throw new Error("Choose a video file to upload.");
				setUploading(true);
				try {
					sourceInput = await uploadMedia(file);
				} finally {
					setUploading(false);
				}
				sourceType = "upload";
			}
			setPhase("running");
			const res = await fetch("/api/shorts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					name: name.trim() || undefined,
					sourceType,
					sourceInput,
					numClips,
					minSeconds,
					maxSeconds,
					aspect,
					cropFocus,
					referenceFaceUrl:
						cropFocus === "auto" ? (referenceFaceUrl ?? undefined) : undefined,
					speed,
					captions,
					selector,
					autoPublishDistributionId: distId || undefined,
				}),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Failed to start");
			subscribe(d.job.id);
		} catch (err) {
			setPhase("failed");
			setError(err instanceof Error ? err.message : "Error");
		}
	}

	const running = phase === "running" || uploading;

	return (
		<div className="space-y-4">
			<form
				onSubmit={submit}
				className="space-y-4 rounded-xl border border-black/10 bg-white p-5 shadow-sm"
			>
				<div>
					<label className={LBL} htmlFor="shorts-name">
						Job name
					</label>
					<input
						id="shorts-name"
						value={name}
						onChange={(e) => setName(e.target.value)}
						type="text"
						placeholder="e.g. Nithyananda Puranima — Russian (optional)"
						className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
					/>
				</div>

				<div>
					{/* Source tabs: a remote URL (yt-dlp) or a local file upload. */}
					<div className="mb-2 inline-flex rounded-md border border-black/15 p-0.5 text-sm">
						<button
							type="button"
							onClick={() => setTab("url")}
							className={`rounded px-3 py-1 ${tab === "url" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
						>
							From URL
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
							<label className={LBL} htmlFor="shorts-url">
								Long video URL
							</label>
							<input
								id="shorts-url"
								value={url}
								onChange={(e) => setUrl(e.target.value)}
								required={tab === "url"}
								type="url"
								placeholder="YouTube / Google Drive link / Instagram…"
								className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
							/>
							<p className="mt-1 text-xs opacity-50">
								Login/rate-limited sources may need cookies — add them under
								Settings.
							</p>
						</>
					) : (
						<>
							<label className={LBL} htmlFor="shorts-file">
								Video file
							</label>
							<input
								id="shorts-file"
								type="file"
								accept="video/*"
								onChange={(e) => setFile(e.target.files?.[0] ?? null)}
								required={tab === "upload"}
								className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
							/>
							<p className="mt-1 text-xs opacity-50">
								{file
									? `${file.name} — ${(file.size / (1024 * 1024)).toFixed(1)} MB`
									: "Upload a long video from your device (max 200 MB)."}
							</p>
						</>
					)}
				</div>

				<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
					<label className={LBL}>
						Clips
						<input
							type="number"
							min={1}
							max={30}
							value={numClips}
							onChange={(e) => setNumClips(Number(e.target.value))}
							className={NUM}
						/>
					</label>
					<label className={LBL}>
						Min sec
						<input
							type="number"
							min={10}
							max={600}
							value={minSeconds}
							onChange={(e) => setMinSeconds(Number(e.target.value))}
							className={NUM}
						/>
					</label>
					<label className={LBL}>
						Max sec
						<input
							type="number"
							min={15}
							max={900}
							value={maxSeconds}
							onChange={(e) => setMaxSeconds(Number(e.target.value))}
							className={NUM}
						/>
					</label>
					<label className={LBL}>
						Aspect
						<select
							value={aspect}
							onChange={(e) => setAspect(e.target.value)}
							className={NUM}
						>
							<option value="9:16">9:16</option>
							<option value="1:1">1:1</option>
							<option value="16:9">16:9</option>
						</select>
					</label>
					<label className={LBL}>
						Focus
						<select
							value={cropFocus}
							onChange={(e) =>
								setCropFocus(
									e.target.value as "auto" | "center" | "left" | "right",
								)
							}
							className={NUM}
						>
							<option value="auto">Auto (face)</option>
							<option value="center">Center</option>
							<option value="left">Left</option>
							<option value="right">Right</option>
						</select>
					</label>
					<label className={LBL}>
						Speed
						<select
							value={speed}
							onChange={(e) => setSpeed(Number(e.target.value))}
							className={NUM}
						>
							<option value={1}>1x</option>
							<option value={1.1}>1.1x</option>
							<option value={1.25}>1.25x</option>
							<option value={1.4}>1.4x</option>
							<option value={1.5}>1.5x</option>
							<option value={1.75}>1.75x</option>
							<option value={2}>2x</option>
						</select>
					</label>
				</div>

				{cropFocus === "auto" && (
					<div className="border-t border-black/5 pt-4">
						<span className={LBL}>Reference face (optional)</span>
						<p className="mt-0.5 mb-2 text-xs opacity-50">
							Upload a clear, front-facing photo of one person. When set, every
							clip stays centered on that person — even if other faces appear.
							Leave empty to track the largest face.
						</p>
						{referenceFaceUrl ? (
							<div className="flex items-center gap-3">
								{/* biome-ignore lint/performance/noImgElement: small external preview */}
								<img
									src={referenceFaceUrl}
									alt="Reference face"
									className="h-14 w-14 rounded-md border border-black/15 object-cover"
								/>
								<button
									type="button"
									onClick={() => {
										setReferenceFaceUrl(null);
										setFaceError(null);
									}}
									className="text-xs text-red-600 hover:underline"
								>
									Remove
								</button>
							</div>
						) : (
							<input
								type="file"
								accept="image/*"
								disabled={uploadingFace}
								onChange={(e) => {
									const f = e.target.files?.[0];
									if (f) uploadFace(f);
								}}
								className="text-xs"
							/>
						)}
						{uploadingFace && (
							<span className="ml-2 text-xs opacity-60">Uploading…</span>
						)}
						{faceError && (
							<p className="mt-1 text-xs text-red-600">{faceError}</p>
						)}
					</div>
				)}

				<div className="flex flex-wrap items-center justify-between gap-4 border-t border-black/5 pt-4">
					<div className="flex flex-wrap items-center gap-4">
						<div className="flex items-center gap-2">
							<span className="text-xs opacity-60">Selection:</span>
							<div className="inline-flex rounded-md border border-black/15 p-0.5 text-xs">
								<button
									type="button"
									onClick={() => setSelector("nim")}
									className={`rounded px-2.5 py-1 ${selector === "nim" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
								>
									Fast (text)
								</button>
								<button
									type="button"
									onClick={() => setSelector("gemini")}
									className={`rounded px-2.5 py-1 ${selector === "gemini" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
								>
									Gemini (visual)
								</button>
							</div>
						</div>
						<label className="flex items-center gap-2 text-xs opacity-80">
							<input
								type="checkbox"
								checked={captions}
								onChange={(e) => setCaptions(e.target.checked)}
							/>
							Burn captions
						</label>
						{distributions.length > 0 && (
							<label className="flex items-center gap-2 text-xs opacity-80">
								Auto-publish:
								<select
									value={distId}
									onChange={(e) => setDistId(e.target.value)}
									title="Spread the finished clips into this list — a slice per ecosystem, drip-scheduled"
									className="rounded-md border border-black/15 px-2 py-1 text-xs"
								>
									<option value="">Off (just generate)</option>
									{distributions.map((d) => {
										const ecos = new Set(d.targets.map((t) => t.profileId))
											.size;
										return (
											<option key={d.id} value={d.id}>
												{d.name} ({ecos} eco · {d.shortsPerTarget}/eco)
											</option>
										);
									})}
								</select>
							</label>
						)}
					</div>

					<button
						type="submit"
						disabled={running}
						className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-white disabled:opacity-50"
					>
						{uploading
							? "Uploading…"
							: running
								? "Generating…"
								: "Generate shorts"}
					</button>
				</div>
			</form>

			{(progress || phase !== "idle") && (
				<div className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
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
					{phase === "done" && (
						<p className="mt-2 text-sm text-green-600">
							Clips ready below — publish them from the table.
						</p>
					)}
				</div>
			)}
		</div>
	);
}
