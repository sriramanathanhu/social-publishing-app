"use client";

import { useMemo, useRef, useState } from "react";
import { BackgroundPicker } from "@/components/background-picker";
import type { Ecosystem } from "@/components/publish-row";
import { readJson } from "@/components/publish-row";
import { QuoteCardPreview } from "@/components/quote-card-preview";
import {
	patchQuoteItem,
	type QuoteBackground,
	type QuoteItem,
	type QuoteOverlay,
} from "@/components/quote-types";

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
 * Batch quote-card workflow over the saved quotes: edit each quote, assign a
 * background per card (bulk upload / library / click-to-cycle), pick one overlay
 * + global framing, render all, then choose accounts + a schedule ONCE and fan
 * every card out (auto-spaced), each as an image post with the quote as caption.
 * All edits/cards persist.
 */
export function QuoteBatchPanel({
	items,
	backgrounds,
	overlays,
	ecosystems,
	onChange,
}: {
	readonly items: QuoteItem[];
	readonly backgrounds: QuoteBackground[];
	readonly overlays: QuoteOverlay[];
	readonly ecosystems: Ecosystem[];
	readonly onChange: (id: string, patch: Partial<QuoteItem>) => void;
}) {
	const defaultOverlay = overlays.find((o) => o.isDefault)?.url ?? null;
	const [pool, setPool] = useState<string[]>(backgrounds.map((b) => b.url));
	const [overlayUrl, setOverlayUrl] = useState<string | null>(defaultOverlay);
	const [panY, setPanY] = useState(0.4);
	const [zoom, setZoom] = useState(1);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [rendering, setRendering] = useState(false);
	const [renderingIds, setRenderingIds] = useState<Set<string>>(new Set());
	const [lightbox, setLightbox] = useState<string | null>(null);
	const [pickerFor, setPickerFor] = useState<string | null>(null);

	const [ecoId, setEcoId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [mode, setMode] = useState<"now" | "schedule">("schedule");
	const [startAt, setStartAt] = useState("");
	const [every, setEvery] = useState(1);
	const [unit, setUnit] = useState<"hours" | "days">("days");
	const [publishing, setPublishing] = useState(false);
	const [done, setDone] = useState(0);
	const [msg, setMsg] = useState<string | null>(null);
	const textTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
		new Map(),
	);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const accounts = (eco?.accounts ?? []).filter((a) =>
		CARD_PLATFORMS.has(a.platform),
	);
	const assignedCount = items.filter((q) => q.bgUrl).length;
	const readyCount = items.filter((q) => q.cardUrl).length;

	function editText(id: string, v: string) {
		onChange(id, { text: v, cardUrl: null });
		const timers = textTimers.current;
		clearTimeout(timers.get(id));
		timers.set(
			id,
			setTimeout(() => patchQuoteItem(id, { text: v }), 600),
		);
	}

	function setBg(id: string, url: string | null) {
		onChange(id, { bgUrl: url, cardUrl: null });
		patchQuoteItem(id, { bgUrl: url, cardUrl: null });
	}

	function assignInOrder(urls: string[]) {
		items.forEach((q, i) => {
			if (i < urls.length) setBg(q.id, urls[i]);
		});
	}

	function fillFromLibrary() {
		if (pool.length === 0) return;
		items.forEach((q, i) => {
			if (!q.bgUrl) setBg(q.id, pool[i % pool.length]);
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

	// Upload one image for a single card (from the gallery picker's "upload").
	async function uploadOne(file: File, cardId: string) {
		setUploadBusy(true);
		setMsg(null);
		try {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch("/api/quotes/card-bg", {
				method: "POST",
				body: fd,
			});
			const d = await readJson(res);
			if (!res.ok)
				throw new Error((d as { error?: string }).error ?? "Upload failed");
			const url = (d as { url?: string }).url;
			if (url) {
				setPool((p) => [url, ...p]);
				setBg(cardId, url);
			}
			setPickerFor(null);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploadBusy(false);
		}
	}

	async function renderAll() {
		setRendering(true);
		setMsg(null);
		const todo = items.filter((q) => q.bgUrl);
		await runPool(todo, 3, async (q) => {
			setRenderingIds((s) => new Set(s).add(q.id));
			try {
				const res = await fetch("/api/quotes/card", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						photoUrl: q.bgUrl,
						overlayUrl: overlayUrl ?? undefined,
						quote: q.text,
						panY,
						zoom,
						finalize: true,
					}),
				});
				const d = await readJson(res);
				if (!res.ok) throw new Error(d.error ?? "render failed");
				const cardUrl = (d as { publicUrl?: string }).publicUrl ?? null;
				onChange(q.id, { cardUrl, bgUrl: q.bgUrl, overlayUrl, panY, zoom });
				patchQuoteItem(q.id, {
					cardUrl,
					bgUrl: q.bgUrl,
					overlayUrl,
					panY,
					zoom,
				});
			} catch {
				onChange(q.id, { cardUrl: null });
			} finally {
				setRenderingIds((s) => {
					const n = new Set(s);
					n.delete(q.id);
					return n;
				});
			}
		});
		setRendering(false);
	}

	const scheduleTimes = useMemo(() => {
		if (mode !== "schedule" || !startAt) return [];
		const base = new Date(startAt).getTime();
		const stepMs = every * (unit === "days" ? 86_400_000 : 3_600_000);
		return items.map((_, i) => new Date(base + i * stepMs));
	}, [mode, startAt, every, unit, items]);

	async function publishAll() {
		const targets = accounts
			.filter((a) => selected.has(a.accountId))
			.map((a) => ({ platform: a.platform, accountId: a.accountId }));
		if (targets.length === 0) {
			setMsg("Pick at least one account.");
			return;
		}
		const ready = items.filter((q) => q.cardUrl);
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
			const when = mode === "schedule" ? scheduleTimes[items.indexOf(q)] : null;
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
						mediaItems: [{ type: "image", url: q.cardUrl }],
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
			{lightbox && (
				<QuoteCardPreview url={lightbox} onClose={() => setLightbox(null)} />
			)}
			{pickerFor && (
				<BackgroundPicker
					backgrounds={backgrounds}
					onSelect={(url) => setBg(pickerFor, url)}
					onClose={() => setPickerFor(null)}
					onUploadFile={(file) => uploadOne(file, pickerFor)}
					uploadBusy={uploadBusy}
				/>
			)}
			<h3 className="text-sm font-semibold">⚡ Batch cards &amp; schedule</h3>

			{/* 1. Cards: quote text + background per item */}
			<section className="space-y-2">
				<div className="flex flex-wrap items-center gap-2 text-sm">
					<span className="font-medium">1. Cards</span>
					<span className="text-xs opacity-50">
						{assignedCount}/{items.length} backgrounds · {readyCount} rendered
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
				<div className="space-y-2">
					{items.map((q, i) => (
						<div
							key={q.id}
							className="flex gap-2 rounded-lg border border-black/10 bg-white p-2"
						>
							<button
								type="button"
								onClick={() =>
									q.cardUrl ? setLightbox(q.cardUrl) : setPickerFor(q.id)
								}
								title={
									q.cardUrl
										? "Click to enlarge"
										: "Click to choose a background from the gallery"
								}
								className="relative h-20 w-16 shrink-0 overflow-hidden rounded border border-black/10 bg-black/5"
							>
								{q.cardUrl || q.bgUrl ? (
									// biome-ignore lint/performance/noImgElement: remote thumb
									<img
										src={q.cardUrl ?? q.bgUrl ?? ""}
										alt={`card ${i + 1}`}
										className="h-full w-full object-cover"
									/>
								) : (
									<span className="flex h-full items-center justify-center text-[10px] opacity-40">
										+
									</span>
								)}
								<span className="absolute left-0 top-0 bg-black/50 px-1 text-[9px] text-white">
									{i + 1}
								</span>
								{renderingIds.has(q.id) && (
									<span className="absolute inset-0 flex items-center justify-center bg-black/40 text-[10px] text-white">
										…
									</span>
								)}
							</button>
							<div className="min-w-0 flex-1">
								<textarea
									value={q.text}
									onChange={(e) => editText(q.id, e.target.value)}
									rows={2}
									className="w-full resize-y rounded-md border border-black/15 px-2 py-1 text-sm"
								/>
								<div className="mt-0.5 flex items-center gap-2 text-[11px] opacity-50">
									<button
										type="button"
										onClick={() => setPickerFor(q.id)}
										className="hover:underline"
									>
										{q.bgUrl ? "change bg" : "choose bg"}
									</button>
									{q.cardUrl && (
										<button
											type="button"
											onClick={() => setLightbox(q.cardUrl as string)}
											className="text-primary hover:underline"
										>
											preview ⛶
										</button>
									)}
								</div>
							</div>
						</div>
					))}
				</div>
			</section>

			{/* 2. Overlay + framing + 3. Render */}
			<section className="flex flex-wrap items-end gap-4 border-t border-black/5 pt-3">
				<div className="text-sm font-medium">2. Style</div>
				{overlays.length > 0 && (
					<label className="text-[11px] opacity-60">
						Overlay
						<select
							value={overlayUrl ?? ""}
							onChange={(e) => setOverlayUrl(e.target.value || null)}
							className="mt-0.5 block rounded-md border border-black/15 px-2 py-1 text-xs"
						>
							{overlays.map((o) => (
								<option key={o.id} value={o.url}>
									{o.label ?? "Overlay"}
								</option>
							))}
						</select>
					</label>
				)}
				<label className="text-[11px] opacity-60">
					Vertical
					<input
						type="range"
						min={0}
						max={1}
						step={0.02}
						value={panY}
						onChange={(e) => setPanY(Number(e.target.value))}
						className="block w-28"
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
						className="block w-28"
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
				{mode === "schedule" && scheduleTimes.length > 1 && (
					<p className="text-xs opacity-50">
						Card 1 → {scheduleTimes[0].toLocaleString()} · … · Card{" "}
						{items.length} → {scheduleTimes[items.length - 1]?.toLocaleString()}
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
