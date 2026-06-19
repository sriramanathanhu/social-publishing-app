"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type ShortsJobRow = {
	id: string;
	status: string;
	pct: number;
	stage: string | null;
	message: string | null;
	sourceInput: string;
	numClips: number;
	error: string | null;
	createdAt: string | Date;
};
type ClipRow = {
	id: string;
	jobId: string;
	idx: number;
	title: string | null;
	description: string | null;
	durationSec: number | null;
	viralScore: number | null;
	publicUrl: string | null;
	status: string;
};
type Progress = { pct: number; stage: string; message: string };

export function ShortsStudio({
	recentJobs,
	clips,
}: {
	recentJobs: ShortsJobRow[];
	clips: ClipRow[];
}) {
	const router = useRouter();
	const [url, setUrl] = useState("");
	const [numClips, setNumClips] = useState(15);
	const [minSeconds, setMinSeconds] = useState(90);
	const [maxSeconds, setMaxSeconds] = useState(120);
	const [aspect, setAspect] = useState("9:16");
	const [cropFocus, setCropFocus] = useState<
		"auto" | "center" | "left" | "right"
	>("auto");
	const [speed, setSpeed] = useState(1);
	const [captions, setCaptions] = useState(true);
	const [selector, setSelector] = useState<"gemini" | "nim">("nim");

	const [progress, setProgress] = useState<Progress | null>(null);
	const [phase, setPhase] = useState<"idle" | "running" | "done" | "failed">(
		"idle",
	);
	const [error, setError] = useState<string | null>(null);
	const esRef = useRef<EventSource | null>(null);

	useEffect(() => () => esRef.current?.close(), []);

	async function syncStatus(id: string) {
		try {
			await fetch(`/api/shorts/${id}`);
		} catch {
			/* refresh re-reads the row */
		}
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
			setPhase("done");
			setProgress((p) => (p ? { ...p, pct: 100 } : null));
			es.close();
			await syncStatus(id);
			router.refresh();
		});
		es.addEventListener("failed", async (e) => {
			setPhase("failed");
			setError((e as MessageEvent).data || "Shorts job failed");
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
		setPhase("running");
		try {
			const res = await fetch("/api/shorts", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					sourceType: "url",
					sourceInput: url,
					numClips,
					minSeconds,
					maxSeconds,
					aspect,
					cropFocus,
					speed,
					captions,
					selector,
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

	const running = phase === "running";

	async function publishClip(clip: ClipRow) {
		if (!clip.publicUrl) return;
		// Hand the clip to the composer as a pre-attached video + caption.
		const params = new URLSearchParams({
			media: clip.publicUrl,
			text: clip.description ?? clip.title ?? "",
		});
		router.push(`/publishing/create?${params.toString()}`);
	}

	return (
		<div className="space-y-6">
			<form
				onSubmit={submit}
				className="space-y-4 rounded-lg border border-black/10 p-4"
			>
				<div>
					<label className="mb-1 block text-xs font-medium opacity-60">
						Long video URL (YouTube / Google Drive link / Instagram)
					</label>
					<input
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						required
						type="url"
						placeholder="https://www.youtube.com/watch?v=…"
						className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
					/>
					<p className="mt-1 text-xs opacity-50">
						Login/rate-limited sources may need cookies — add them under
						Settings.
					</p>
				</div>

				<div className="grid gap-4 sm:grid-cols-3">
					<label className="block text-xs font-medium opacity-60">
						Clips
						<input
							type="number"
							min={1}
							max={30}
							value={numClips}
							onChange={(e) => setNumClips(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						/>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Min seconds
						<input
							type="number"
							min={10}
							max={600}
							value={minSeconds}
							onChange={(e) => setMinSeconds(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						/>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Max seconds
						<input
							type="number"
							min={15}
							max={900}
							value={maxSeconds}
							onChange={(e) => setMaxSeconds(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						/>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Aspect
						<select
							value={aspect}
							onChange={(e) => setAspect(e.target.value)}
							className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						>
							<option value="9:16">9:16 (Shorts/Reels)</option>
							<option value="1:1">1:1 (Square)</option>
							<option value="16:9">16:9 (Wide)</option>
						</select>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Focus
						<select
							value={cropFocus}
							onChange={(e) =>
								setCropFocus(
									e.target.value as "auto" | "center" | "left" | "right",
								)
							}
							className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						>
							<option value="auto">Auto (face)</option>
							<option value="center">Center</option>
							<option value="left">Left</option>
							<option value="right">Right</option>
						</select>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Speed
						<select
							value={speed}
							onChange={(e) => setSpeed(Number(e.target.value))}
							className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
						>
							<option value={1}>1x (normal)</option>
							<option value={1.1}>1.1x</option>
							<option value={1.25}>1.25x</option>
							<option value={1.4}>1.4x</option>
							<option value={1.5}>1.5x</option>
							<option value={1.75}>1.75x</option>
							<option value={2}>2x</option>
						</select>
					</label>
				</div>

				<div>
					<div className="mb-1 text-xs font-medium opacity-60">
						Clip selection
					</div>
					<div className="inline-flex rounded-md border border-black/15 p-0.5 text-sm">
						<button
							type="button"
							onClick={() => setSelector("gemini")}
							className={`rounded px-3 py-1 ${selector === "gemini" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
						>
							Gemini (visual)
						</button>
						<button
							type="button"
							onClick={() => setSelector("nim")}
							className={`rounded px-3 py-1 ${selector === "nim" ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
						>
							Fast (text)
						</button>
					</div>
					<p className="mt-1 text-xs opacity-50">
						Gemini watches the video for stronger picks (needs a Gemini key in
						Settings; falls back to the text model automatically). Fast uses the
						transcript only.
					</p>
				</div>

				<label className="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						checked={captions}
						onChange={(e) => setCaptions(e.target.checked)}
					/>
					Burn word-by-word captions into each clip
				</label>

				<button
					type="submit"
					disabled={running}
					className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
				>
					{running ? "Generating…" : "Generate shorts"}
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
					{phase === "done" && (
						<p className="mt-2 text-sm text-green-600">
							Clips ready below. They’re saved to R2.
						</p>
					)}
				</div>
			)}

			{recentJobs.map((job) => {
				const jobClips = clips.filter((c) => c.jobId === job.id);
				return (
					<div key={job.id} className="rounded-lg border border-black/10">
						<div className="flex items-center justify-between gap-4 border-b border-black/5 px-4 py-3 text-sm">
							<div className="min-w-0">
								<div className="truncate">{job.sourceInput}</div>
								<div className="text-xs opacity-50">
									{jobClips.length}/{job.numClips} clips ·{" "}
									{new Date(job.createdAt).toLocaleString()}
								</div>
							</div>
							<span
								className={`rounded px-1.5 py-0.5 text-xs ${
									job.status === "done"
										? "bg-green-100 text-green-700"
										: job.status === "failed"
											? "bg-red-100 text-red-700"
											: "bg-blue-100 text-blue-700"
								}`}
							>
								{job.status}
							</span>
						</div>
						{job.error && (
							<p className="px-4 py-2 text-xs text-red-600">{job.error}</p>
						)}
						{jobClips.length > 0 && (
							<div className="divide-y divide-black/5">
								{jobClips.map((c) => (
									<div
										key={c.id}
										className="flex items-center justify-between gap-3 px-4 py-2 text-sm"
									>
										<div className="min-w-0">
											<div className="truncate font-medium">
												#{c.idx} {c.title}
											</div>
											<div className="truncate text-xs opacity-50">
												{c.durationSec ? `${c.durationSec}s` : ""}
												{c.viralScore ? ` · score ${c.viralScore}` : ""}
												{c.description ? ` · ${c.description}` : ""}
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-3 text-xs">
											{c.publicUrl ? (
												<>
													<a
														href={c.publicUrl}
														target="_blank"
														rel="noreferrer"
														className="underline opacity-70 hover:opacity-100"
													>
														Open
													</a>
													<button
														type="button"
														onClick={() => publishClip(c)}
														className="font-medium text-primary"
													>
														Publish
													</button>
												</>
											) : (
												<span
													className="opacity-40"
													title="Set R2_PUBLIC_BASE_URL (custom domain) to get public links"
												>
													stored (no public URL yet)
												</span>
											)}
										</div>
									</div>
								))}
							</div>
						)}
					</div>
				);
			})}
		</div>
	);
}
