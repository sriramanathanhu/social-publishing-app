"use client";

import { useMemo, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";
import { readJson } from "@/components/publish-row";
import type { QuoteBackground } from "@/components/quote-row";

type Quote = { id: number; text: string; hashtags: string[] };

/** Image-capable platforms (cards are images). */
const CARD_PLATFORMS = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"bluesky",
	"threads",
	"instagram",
	"pinterest",
	"reddit",
	"telegram",
	"discord",
	"whatsapp",
	"googlebusiness",
]);

type CardState = {
	bg: string | null; // background url
	cardUrl: string | null; // finalized R2 card url
	status: "" | "rendering" | "ready" | "error";
};

/** Run async work over items with a small concurrency cap, reporting progress. */
async function runPool<T>(
	items: T[],
	limit: number,
	fn: (item: T, i: number) => Promise<void>,
) {
	let next = 0;
	async function worker() {
		while (next < items.length) {
			const i = next++;
			await fn(items[i], i);
		}
	}
	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, worker),
	);
}

/**
 * Batch quote-card workflow: assign a background per quote (bulk upload / library
 * / per-card), render every card, then choose accounts + a schedule ONCE and
 * fan all of them out (auto-spaced across the calendar).
 */
export function QuoteBatchPanel({
	quotes,
	backgrounds,
	ecosystems,
}: {
	readonly quotes: Quote[];
	readonly backgrounds: QuoteBackground[];
	readonly ecosystems: Ecosystem[];
}) {
	// Pool of selectable backgrounds = library + anything uploaded here.
	const [pool, setPool] = useState<string[]>(backgrounds.map((b) => b.url));
	const [cards, setCards] = useState<Record<number, CardState>>(() =>
		Object.fromEntries(
			quotes.map((q) => [q.id, { bg: null, cardUrl: null, status: "" }]),
		),
	);
	const [panY, setPanY] = useState(0.4);
	const [zoom, setZoom] = useState(1);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [rendering, setRendering] = useState(false);

	const [ecoId, setEcoId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<"now" | "schedule">("schedule");
	const [startAt, setStartAt] = useState("");
	const [every, setEvery] = useState(1);
	const [unit, setUnit] = useState<"hours" | "days">("days");
	const [publishing, setPublishing] = useState(false);
	const [done, setDone] = useState(0);
	const [msg, setMsg] = useState<string | null>(null);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const accounts = (eco?.accounts ?? []).filter((a) =>
		CARD_PLATFORMS.has(a.platform),
	);
	const assignedCount = quotes.filter((q) => cards[q.id]?.bg).length;
	const readyCount = quotes.filter((q) => cards[q.id]?.cardUrl).length;

	const update = (id: number, patch: Partial<CardState>) =>
		setCards((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));

	function assignInOrder(urls: string[]) {
		setCards((prev) => {
			const next = { ...prev };
			quotes.forEach((q, i) => {
				if (i < urls.length)
					next[q.id] = {
						...next[q.id],
						bg: urls[i],
						cardUrl: null,
						status: "",
					};
			});
			return next;
		});
	}

	function fillFromLibrary() {
		if (pool.length === 0) return;
		setCards((prev) => {
			const next = { ...prev };
			quotes.forEach((q, i) => {
				if (!next[q.id].bg)
					next[q.id] = {
						...next[q.id],
						bg: pool[i % pool.length],
						cardUrl: null,
					};
			});
			return next;
		});
	}

	function cycleBg(id: number) {
		if (pool.length === 0) return;
		const cur = cards[id].bg;
		const idx = cur ? pool.indexOf(cur) : -1;
		update(id, {
			bg: pool[(idx + 1) % pool.length],
			cardUrl: null,
			status: "",
		});
	}

	async function uploadMany(files: FileList) {
		setUploadBusy(true);
		setMsg(null);
		try {
			const urls: string[] = [];
			for (const file of Array.from(files)) {
				const fd = new FormData();
				fd.append("file", file);
				const res = await fetch("/api/quotes/card-bg", {
					method: "POST",
					body: fd,
				});
				const d = await readJson(res);
				if (!res.ok) throw new Error(d.error ?? "Upload failed");
				if ((d as { url?: string }).url) urls.push((d as { url: string }).url);
			}
			setPool((p) => [...urls, ...p]);
			assignInOrder(urls);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploadBusy(false);
		}
	}

	async function renderAll() {
		setRendering(true);
		setMsg(null);
		const todo = quotes.filter((q) => cards[q.id]?.bg);
		await runPool(todo, 3, async (q) => {
			update(q.id, { status: "rendering" });
			try {
				const res = await fetch("/api/quotes/card", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						photoUrl: cards[q.id].bg,
						quote: q.text,
						panY,
						zoom,
						finalize: true,
					}),
				});
				const d = await readJson(res);
				if (!res.ok) throw new Error(d.error ?? "render failed");
				update(q.id, {
					cardUrl: (d as { publicUrl?: string }).publicUrl ?? null,
					status: "ready",
				});
			} catch {
				update(q.id, { status: "error" });
			}
		});
		setRendering(false);
	}

	// Scheduled time for card index i.
	const scheduleTimes = useMemo(() => {
		if (mode !== "schedule" || !startAt) return [];
		const base = new Date(startAt).getTime();
		const stepMs = every * (unit === "days" ? 86_400_000 : 3_600_000);
		return quotes.map((_, i) => new Date(base + i * stepMs));
	}, [mode, startAt, every, unit, quotes]);

	async function publishAll() {
		const targets = accounts
			.filter((a) => selected.has(a.accountId))
			.map((a) => ({ platform: a.platform, accountId: a.accountId }));
		if (targets.length === 0) {
			setMsg("Pick at least one account.");
			return;
		}
		const ready = quotes.filter((q) => cards[q.id]?.cardUrl);
		if (ready.length === 0) {
			setMsg("Render the cards first.");
			return;
		}
		if (mode === "schedule" && !startAt) {
			setMsg("Set a start time.");
			return;
		}
		setPublishing(true);
		setDone(0);
		setMsg(null);
		let failures = 0;
		for (let i = 0; i < ready.length; i++) {
			const q = ready[i];
			const when =
				mode === "schedule" ? scheduleTimes[quotes.indexOf(q)] : null;
			const caption = q.hashtags.length
				? `${q.text}\n\n${q.hashtags.map((h) => `#${h}`).join(" ")}`
				: q.text;
			try {
				const res = await fetch(`/api/profiles/${ecoId}/posts`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: caption,
						platforms: targets,
						mediaItems: [{ type: "image", url: cards[q.id].cardUrl }],
						publishNow: when ? undefined : true,
						scheduledFor: when ? when.toISOString() : undefined,
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						source: "quote",
					}),
				});
				if (!res.ok) failures++;
			} catch {
				failures++;
			}
			setDone(i + 1);
		}
		setPublishing(false);
		setMsg(
			failures
				? `${ready.length - failures}/${ready.length} ${mode === "schedule" ? "scheduled" : "published"} · ${failures} failed`
				: `All ${ready.length} ${mode === "schedule" ? "scheduled" : "published"} ✓`,
		);
	}

	function toggle(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	}

	return (
		<div className="space-y-4 rounded-xl border border-primary/30 bg-primary/[0.03] p-4">
			<h3 className="text-sm font-semibold">⚡ Batch cards &amp; schedule</h3>

			{/* 1. Backgrounds */}
			<section className="space-y-2">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="font-medium">1. Backgrounds</span>
					<span className="text-xs opacity-50">
						{assignedCount}/{quotes.length} assigned
					</span>
					<label className="cursor-pointer rounded-md border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5">
						{uploadBusy ? "Uploading…" : "Upload images (in order)"}
						<input
							type="file"
							accept="image/jpeg,image/png,image/webp"
							multiple
							className="hidden"
							disabled={uploadBusy}
							onChange={(e) => {
								if (e.target.files?.length) uploadMany(e.target.files);
							}}
						/>
					</label>
					<button
						type="button"
						onClick={fillFromLibrary}
						disabled={pool.length === 0}
						className="rounded-md border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5 disabled:opacity-40"
					>
						Fill from library
					</button>
				</div>
				<div className="grid grid-cols-4 gap-2 sm:grid-cols-6 lg:grid-cols-8">
					{quotes.map((q, i) => {
						const c = cards[q.id];
						return (
							<button
								type="button"
								key={q.id}
								onClick={() => cycleBg(q.id)}
								title={`Card ${i + 1}: ${q.text.slice(0, 60)} — click to change background`}
								className="relative aspect-[4/5] overflow-hidden rounded border border-black/10 bg-black/5"
							>
								{c.cardUrl || c.bg ? (
									// biome-ignore lint/performance/noImgElement: remote thumb
									<img
										src={c.cardUrl ?? c.bg ?? ""}
										alt={`card ${i + 1}`}
										className="h-full w-full object-cover"
									/>
								) : (
									<span className="flex h-full items-center justify-center text-[10px] opacity-40">
										{i + 1}
									</span>
								)}
								<span className="absolute left-0 top-0 bg-black/50 px-1 text-[9px] text-white">
									{i + 1}
								</span>
								{c.status === "rendering" && (
									<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] text-white">
										…
									</span>
								)}
								{c.status === "error" && (
									<span className="absolute inset-0 flex items-center justify-center bg-red-600/60 text-[10px] text-white">
										✗
									</span>
								)}
							</button>
						);
					})}
				</div>
			</section>

			{/* 2. Framing + 3. Render */}
			<section className="flex flex-wrap items-end gap-4">
				<div className="text-sm font-medium">2. Framing</div>
				<label className="text-[11px] opacity-60">
					Vertical
					<input
						type="range"
						min={0}
						max={1}
						step={0.02}
						value={panY}
						onChange={(e) => setPanY(Number(e.target.value))}
						className="block w-32"
					/>
				</label>
				<label className="text-[11px] opacity-60">
					Zoom
					<input
						type="range"
						min={1}
						max={2.5}
						step={0.05}
						value={zoom}
						onChange={(e) => setZoom(Number(e.target.value))}
						className="block w-32"
					/>
				</label>
				<button
					type="button"
					onClick={renderAll}
					disabled={rendering || assignedCount === 0}
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
				>
					{rendering
						? `Rendering… (${readyCount}/${assignedCount})`
						: `3. Render all cards (${assignedCount})`}
				</button>
				{readyCount > 0 && !rendering && (
					<span className="text-xs text-green-600">{readyCount} ready</span>
				)}
			</section>

			{/* 4. Target + 5. Schedule */}
			<section className="space-y-2 border-t border-black/5 pt-3">
				<div className="text-sm font-medium">4. Publish to</div>
				<select
					value={ecoId}
					onChange={(e) => {
						setEcoId(e.target.value);
						setSelected(new Set());
					}}
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm sm:w-auto"
				>
					<option value="">Choose ecosystem…</option>
					{ecosystems.map((e) => (
						<option key={e.id} value={e.id}>
							{e.teamName} › {e.name}
						</option>
					))}
				</select>
				{eco &&
					(accounts.length === 0 ? (
						<p className="text-xs opacity-50">
							No image-capable accounts in this ecosystem.
						</p>
					) : (
						<div className="flex flex-wrap gap-2">
							{accounts.map((a) => (
								<button
									type="button"
									key={a.accountId}
									onClick={() => toggle(a.accountId)}
									className={`rounded-full border px-3 py-1 text-xs ${
										selected.has(a.accountId)
											? "border-primary bg-primary text-white"
											: "border-black/15 hover:bg-black/5"
									}`}
								>
									{a.platform}
									{a.handle ? ` · ${a.handle}` : ""}
								</button>
							))}
						</div>
					))}

				<div className="text-sm font-medium">5. Schedule</div>
				<div className="flex flex-wrap items-center gap-3 text-sm">
					<label className="flex items-center gap-1">
						<input
							type="radio"
							checked={mode === "now"}
							onChange={() => setMode("now")}
						/>
						Publish all now
					</label>
					<label className="flex items-center gap-1">
						<input
							type="radio"
							checked={mode === "schedule"}
							onChange={() => setMode("schedule")}
						/>
						Schedule
					</label>
					{mode === "schedule" && (
						<>
							<input
								type="datetime-local"
								value={startAt}
								onChange={(e) => setStartAt(e.target.value)}
								className="rounded-md border border-black/15 px-2 py-1 text-xs"
							/>
							<span className="text-xs opacity-60">then every</span>
							<input
								type="number"
								min={1}
								max={60}
								value={every}
								onChange={(e) => setEvery(Number(e.target.value))}
								className="w-16 rounded-md border border-black/15 px-2 py-1 text-xs"
							/>
							<select
								value={unit}
								onChange={(e) => setUnit(e.target.value as "hours" | "days")}
								className="rounded-md border border-black/15 px-2 py-1 text-xs"
							>
								<option value="hours">hours</option>
								<option value="days">days</option>
							</select>
						</>
					)}
				</div>
				{mode === "schedule" && scheduleTimes.length > 0 && (
					<p className="text-xs opacity-50">
						Card 1 → {scheduleTimes[0].toLocaleString()} · Card 2 →{" "}
						{scheduleTimes[1]?.toLocaleString()} · … · Card {quotes.length} →{" "}
						{scheduleTimes[quotes.length - 1]?.toLocaleString()}
					</p>
				)}

				<div className="flex flex-wrap items-center gap-3 pt-1">
					<button
						type="button"
						onClick={publishAll}
						disabled={publishing || readyCount === 0}
						className="rounded-md bg-primary px-5 py-2 text-sm font-medium text-white disabled:opacity-50"
					>
						{publishing
							? `Working… (${done}/${readyCount})`
							: `▶ ${mode === "schedule" ? "Schedule" : "Publish"} all (${readyCount})`}
					</button>
					{msg && (
						<span
							className={`text-sm ${msg.includes("✓") ? "text-green-600" : "text-red-600"}`}
						>
							{msg}
						</span>
					)}
				</div>
			</section>
		</div>
	);
}
