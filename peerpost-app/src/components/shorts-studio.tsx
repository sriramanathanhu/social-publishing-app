"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Progress = { pct: number; stage: string; message: string };

const NUM =
	"mt-1 w-full rounded-md border border-black/15 px-2.5 py-1.5 text-sm";
const LBL = "block text-xs font-medium opacity-60";

/** Compose a shorts job and stream its progress. Clips are published from the
 * ShortsTable below, which re-renders when this calls router.refresh(). */
export function ShortsStudio() {
	const router = useRouter();
	const [url, setUrl] = useState("");
	const [numClips, setNumClips] = useState(3);
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

	return (
		<div className="space-y-4">
			<form
				onSubmit={submit}
				className="space-y-4 rounded-xl border border-black/10 bg-white p-5 shadow-sm"
			>
				<div>
					<label className={LBL} htmlFor="shorts-url">
						Long video URL
					</label>
					<input
						id="shorts-url"
						value={url}
						onChange={(e) => setUrl(e.target.value)}
						required
						type="url"
						placeholder="YouTube / Google Drive link / Instagram…"
						className="mt-1 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
					/>
					<p className="mt-1 text-xs opacity-50">
						Login/rate-limited sources may need cookies — add them under
						Settings.
					</p>
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
					</div>

					<button
						type="submit"
						disabled={running}
						className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-white disabled:opacity-50"
					>
						{running ? "Generating…" : "Generate shorts"}
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
