"use client";

import { useEffect, useRef, useState } from "react";
import {
	type Ecosystem,
	type Provider,
	readJson,
} from "@/components/publish-row";

export type QuoteBackground = { id: string; url: string; label: string | null };

/** Platforms that accept a text-only post. */
const TEXT_PLATFORMS = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"bluesky",
	"threads",
	"reddit",
	"telegram",
	"discord",
	"whatsapp",
	"googlebusiness",
]);
/** Platforms that accept an image post (card mode) — i.e. not video-only. */
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

const PROVIDER_LABEL: Record<Provider, string> = {
	postpeer: "PostPeer",
	zernio: "Zernio",
};

type RowResult = {
	platform: string;
	status: "publishing" | "published" | "scheduled" | "failed";
	error?: string;
	url?: string;
};

/**
 * One generated quote with an inline publish/schedule composer. Two modes:
 * - Text: post the quote as text to text-capable accounts (with per-platform
 *   tailoring).
 * - Image card: composite the quote onto a branded 1080×1350 card (pick a
 *   background, pan/zoom, live preview) and post it as an image to image-capable
 *   accounts. Mirrors PublishRow's background publish + status polling.
 */
export function QuoteRow({
	initialText,
	hashtags,
	ecosystems,
	backgrounds,
	tone,
	regenerating,
	onRegenerate,
}: {
	readonly initialText: string;
	readonly hashtags: string[];
	readonly ecosystems: Ecosystem[];
	readonly backgrounds: QuoteBackground[];
	readonly tone?: string;
	readonly regenerating?: boolean;
	readonly onRegenerate?: () => void;
}) {
	const [text, setText] = useState(initialText);
	const [includeTags, setIncludeTags] = useState(hashtags.length > 0);
	const [ecoId, setEcoId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [provider, setProvider] = useState<Provider>("postpeer");
	const [scheduledFor, setScheduledFor] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<RowResult[]>([]);
	const [tailored, setTailored] = useState<Record<string, string>>({});
	const [tailoring, setTailoring] = useState(false);

	// Image-card mode.
	const [cardMode, setCardMode] = useState(false);
	const [bgUrl, setBgUrl] = useState<string | null>(null);
	const [panY, setPanY] = useState(0.4);
	const [zoom, setZoom] = useState(1);
	const [preview, setPreview] = useState<string | null>(null);
	const [rendering, setRendering] = useState(false);
	const [uploadBusy, setUploadBusy] = useState(false);
	const debounce = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const platformSet = cardMode ? CARD_PLATFORMS : TEXT_PLATFORMS;
	const eligible = (eco?.accounts ?? []).filter((a) =>
		platformSet.has(a.platform),
	);
	const providers = Array.from(
		new Set(eligible.map((a) => a.provider ?? "postpeer")),
	) as Provider[];
	const showProviderToggle = providers.length > 1;
	const visibleAccounts = eligible.filter((a) =>
		showProviderToggle ? (a.provider ?? "postpeer") === provider : true,
	);
	const selectedPlatforms = [
		...new Set(
			visibleAccounts
				.filter((a) => selected.has(a.accountId))
				.map((a) => a.platform),
		),
	];

	const tagLine = hashtags.map((h) => `#${h}`).join(" ");
	const body = includeTags && tagLine ? `${text}\n\n${tagLine}` : text;
	const chars = body.length;

	// Live card preview (debounced) when in card mode with a background chosen.
	useEffect(() => {
		if (!cardMode || !bgUrl || !text.trim()) {
			setPreview(null);
			return;
		}
		setRendering(true);
		clearTimeout(debounce.current);
		debounce.current = setTimeout(async () => {
			try {
				const res = await fetch("/api/quotes/card", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ photoUrl: bgUrl, quote: text, panY, zoom }),
				});
				if (!res.ok) {
					const d = await res.json().catch(() => ({}));
					throw new Error(d.error ?? "Render failed");
				}
				const url = URL.createObjectURL(await res.blob());
				setPreview((prev) => {
					if (prev) URL.revokeObjectURL(prev);
					return url;
				});
				setMsg(null);
			} catch (e) {
				setMsg(e instanceof Error ? e.message : "Render failed");
			} finally {
				setRendering(false);
			}
		}, 500);
		return () => clearTimeout(debounce.current);
	}, [cardMode, bgUrl, text, panY, zoom]);

	function pickEco(id: string) {
		setEcoId(id);
		setSelected(new Set());
		setResults([]);
		setMsg(null);
		setTailored({});
		const e = ecosystems.find((x) => x.id === id);
		const provs = Array.from(
			new Set(
				(e?.accounts ?? [])
					.filter((a) => platformSet.has(a.platform))
					.map((a) => a.provider ?? "postpeer"),
			),
		) as Provider[];
		setProvider(
			provs.includes("postpeer") ? "postpeer" : (provs[0] ?? "postpeer"),
		);
	}

	function toggle(accountId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(accountId)) next.delete(accountId);
			else next.add(accountId);
			return next;
		});
	}

	async function uploadBackground(file: File) {
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
			if (!res.ok) throw new Error(d.error ?? "Upload failed");
			setBgUrl((d as { url?: string }).url ?? null);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploadBusy(false);
		}
	}

	async function tailor() {
		if (selectedPlatforms.length === 0) {
			setMsg("Select accounts first, then tailor.");
			return;
		}
		setTailoring(true);
		setMsg(null);
		try {
			const res = await fetch("/api/quotes/tailor", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					quote: body,
					platforms: selectedPlatforms,
					tone,
				}),
			});
			const d = await readJson(res);
			if (!res.ok) throw new Error(d.error ?? "Tailoring failed");
			setTailored((d as { variants?: Record<string, string> }).variants ?? {});
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setTailoring(false);
		}
	}

	async function publish() {
		const accounts = visibleAccounts.filter((a) => selected.has(a.accountId));
		if (accounts.length === 0) {
			setMsg("Select at least one account.");
			return;
		}
		if (!body.trim()) {
			setMsg("Quote is empty.");
			return;
		}
		setBusy(true);
		setMsg(null);
		setResults([]);

		// Card mode: finalize the card to a public URL to attach as media.
		let mediaUrl: string | undefined;
		if (cardMode) {
			if (!bgUrl) {
				setMsg("Pick or upload a background first.");
				setBusy(false);
				return;
			}
			try {
				const res = await fetch("/api/quotes/card", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						photoUrl: bgUrl,
						quote: text,
						panY,
						zoom,
						finalize: true,
					}),
				});
				const d = await readJson(res);
				if (!res.ok) throw new Error(d.error ?? "Card render failed");
				mediaUrl = (d as { publicUrl?: string }).publicUrl;
				if (!mediaUrl) throw new Error("Card render returned no URL");
			} catch (err) {
				setMsg(err instanceof Error ? err.message : "Card render failed");
				setBusy(false);
				return;
			}
		}

		const targets = accounts.map((a) => ({
			platform: a.platform,
			accountId: a.accountId,
			content: tailored[a.platform] || undefined,
		}));
		let jobs: { id: string; platform: string }[] = [];
		try {
			const res = await fetch(`/api/profiles/${ecoId}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: body,
					platforms: targets,
					mediaItems: mediaUrl ? [{ type: "image", url: mediaUrl }] : undefined,
					publishNow: scheduledFor ? undefined : true,
					scheduledFor: scheduledFor
						? new Date(scheduledFor).toISOString()
						: undefined,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					source: "quote",
				}),
			});
			const d = await readJson(res);
			if (!res.ok) throw new Error(d.error ?? "Publish failed");
			jobs = d.jobs ?? [];
			if (jobs.length === 0) throw new Error("Nothing was queued to publish.");
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
			setBusy(false);
			return;
		}
		setResults(
			jobs.map((j) => ({ platform: j.platform, status: "publishing" })),
		);
		setMsg(scheduledFor ? "Scheduling…" : "Publishing…");
		pollStatuses(jobs, !!scheduledFor);
	}

	function pollStatuses(
		jobs: { id: string; platform: string }[],
		sched: boolean,
	) {
		const ids = jobs.map((j) => j.id).join(",");
		const started = Date.now();
		const tick = async () => {
			try {
				const r = await fetch(`/api/profiles/${ecoId}/posts/status?ids=${ids}`);
				const d = await readJson(r);
				const byId = new Map((d.statuses ?? []).map((s) => [s.id, s]));
				const updated: RowResult[] = jobs.map((j) => {
					const st = byId.get(j.id)?.status ?? "publishing";
					const status =
						st === "published" || st === "scheduled" || st === "failed"
							? (st as RowResult["status"])
							: "publishing";
					return {
						platform: j.platform,
						status,
						error: byId.get(j.id)?.error ?? undefined,
						url: byId.get(j.id)?.url ?? undefined,
					};
				});
				setResults(updated);
				const pending = updated.some(
					(u) =>
						u.status === "publishing" || (u.status === "published" && !u.url),
				);
				if (pending && Date.now() - started < 180_000) {
					setTimeout(tick, 3000);
					return;
				}
				const failed = updated.filter((u) => u.status === "failed").length;
				setMsg(
					failed
						? `${updated.length - failed}/${updated.length} ${sched ? "scheduled" : "published"} · ${failed} failed`
						: sched
							? "Scheduled ✓"
							: "Published ✓",
				);
				setBusy(false);
			} catch {
				if (Date.now() - started < 180_000) setTimeout(tick, 4000);
				else {
					setMsg("Lost track of publish status — check the post log.");
					setBusy(false);
				}
			}
		};
		setTimeout(tick, 2000);
	}

	const tailoredPlatforms = Object.keys(tailored);

	return (
		<div className="rounded-xl border border-black/10 bg-white p-3 shadow-sm">
			<div className="flex items-start gap-2">
				<textarea
					value={text}
					onChange={(e) => setText(e.target.value)}
					rows={3}
					disabled={regenerating}
					className="w-full resize-y rounded-md border border-black/15 px-3 py-2 text-sm disabled:opacity-50"
				/>
				{onRegenerate && (
					<button
						type="button"
						onClick={onRegenerate}
						disabled={regenerating}
						title="Replace with a different quote"
						className="shrink-0 rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-50"
					>
						{regenerating ? "…" : "↻"}
					</button>
				)}
			</div>

			<div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
				{hashtags.length > 0 && (
					<label className="flex items-center gap-1 opacity-70">
						<input
							type="checkbox"
							checked={includeTags}
							onChange={(e) => setIncludeTags(e.target.checked)}
						/>
						{tagLine}
					</label>
				)}
				<label className="flex items-center gap-1 opacity-70">
					<input
						type="checkbox"
						checked={cardMode}
						onChange={(e) => {
							setCardMode(e.target.checked);
							setSelected(new Set());
							setResults([]);
						}}
					/>
					🎨 Image card
				</label>
				<span
					className={`ml-auto tabular-nums ${chars > 280 ? "text-amber-600" : "opacity-40"}`}
				>
					{chars} chars
				</span>
			</div>

			{/* Card designer */}
			{cardMode && (
				<div className="mt-2 grid gap-3 rounded-lg bg-black/[0.02] p-2 sm:grid-cols-[200px_1fr]">
					<div>
						{preview ? (
							// biome-ignore lint/performance/noImgElement: client-side blob preview
							<img
								src={preview}
								alt="card preview"
								className="w-full rounded-md border border-black/10"
							/>
						) : (
							<div className="flex aspect-[4/5] w-full items-center justify-center rounded-md border border-dashed border-black/15 text-xs opacity-40">
								{rendering ? "Rendering…" : bgUrl ? "…" : "Pick a background →"}
							</div>
						)}
					</div>
					<div className="space-y-2">
						<div className="text-[11px] font-medium uppercase tracking-wide opacity-40">
							Background
						</div>
						<div className="flex flex-wrap gap-1.5">
							{backgrounds.map((b) => (
								<button
									type="button"
									key={b.id}
									onClick={() => setBgUrl(b.url)}
									title={b.label ?? ""}
									className={`h-12 w-12 overflow-hidden rounded border-2 ${bgUrl === b.url ? "border-primary" : "border-transparent"}`}
								>
									{/* biome-ignore lint/performance/noImgElement: small remote thumb */}
									<img
										src={b.url}
										alt={b.label ?? "bg"}
										className="h-full w-full object-cover"
									/>
								</button>
							))}
							<label className="flex h-12 w-12 cursor-pointer items-center justify-center rounded border border-dashed border-black/20 text-lg opacity-50 hover:opacity-100">
								{uploadBusy ? "…" : "+"}
								<input
									type="file"
									accept="image/jpeg,image/png,image/webp"
									className="hidden"
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) uploadBackground(f);
									}}
								/>
							</label>
						</div>
						{bgUrl && (
							<div className="space-y-1.5 pt-1">
								<label className="block text-[11px] opacity-60">
									Vertical position
									<input
										type="range"
										min={0}
										max={1}
										step={0.02}
										value={panY}
										onChange={(e) => setPanY(Number(e.target.value))}
										className="w-full"
									/>
								</label>
								<label className="block text-[11px] opacity-60">
									Zoom
									<input
										type="range"
										min={1}
										max={2.5}
										step={0.05}
										value={zoom}
										onChange={(e) => setZoom(Number(e.target.value))}
										className="w-full"
									/>
								</label>
								{preview && (
									<a
										href={preview}
										download="quote-card.png"
										className="inline-block text-[11px] text-primary hover:underline"
									>
										Download PNG ↓
									</a>
								)}
							</div>
						)}
					</div>
				</div>
			)}

			<div className="mt-2 border-t border-black/5 pt-2">
				<select
					value={ecoId}
					onChange={(e) => pickEco(e.target.value)}
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
				>
					<option value="">Publish to ecosystem…</option>
					{ecosystems.map((e) => (
						<option key={e.id} value={e.id}>
							{e.teamName} › {e.name}
						</option>
					))}
				</select>

				{eco && (
					<div className="mt-2 space-y-2">
						{showProviderToggle && (
							<div className="flex items-center gap-1 text-xs">
								<span className="opacity-50">Via:</span>
								{providers.map((p) => (
									<button
										type="button"
										key={p}
										onClick={() => {
											setProvider(p);
											setSelected(new Set());
											setTailored({});
										}}
										className={`rounded px-2 py-0.5 ${provider === p ? "bg-primary text-white" : "border border-black/15 hover:bg-black/5"}`}
									>
										{PROVIDER_LABEL[p]}
									</button>
								))}
							</div>
						)}

						{visibleAccounts.length === 0 ? (
							<p className="text-xs opacity-50">
								{cardMode
									? "No image-capable accounts in this ecosystem."
									: "No text-capable accounts here (X, LinkedIn, Facebook, Bluesky, Threads, …)."}
							</p>
						) : (
							<div className="flex flex-wrap items-center gap-2">
								{visibleAccounts.map((a) => (
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
								{!cardMode && (
									<button
										type="button"
										onClick={tailor}
										disabled={tailoring || selectedPlatforms.length === 0}
										title="Rewrite this quote to fit each selected platform"
										className="rounded-full border border-primary/40 px-3 py-1 text-xs text-primary hover:bg-primary/5 disabled:opacity-40"
									>
										{tailoring ? "Tailoring…" : "✨ Tailor per platform"}
									</button>
								)}
							</div>
						)}

						{!cardMode && tailoredPlatforms.length > 0 && (
							<div className="space-y-1.5 rounded-lg bg-black/[0.02] p-2">
								<div className="text-[11px] font-medium uppercase tracking-wide opacity-40">
									Tailored versions
								</div>
								{tailoredPlatforms.map((p) => (
									<div key={p}>
										<div className="flex items-center justify-between text-[11px] opacity-60">
											<span className="font-medium">{p}</span>
											<span className="tabular-nums">
												{tailored[p].length} chars
											</span>
										</div>
										<textarea
											value={tailored[p]}
											onChange={(e) =>
												setTailored((prev) => ({
													...prev,
													[p]: e.target.value,
												}))
											}
											rows={2}
											className="w-full resize-y rounded-md border border-black/15 px-2 py-1 text-xs"
										/>
									</div>
								))}
							</div>
						)}

						<div className="flex flex-wrap items-center gap-3">
							<label className="text-xs opacity-60">
								Schedule (optional){" "}
								<input
									type="datetime-local"
									value={scheduledFor}
									onChange={(e) => setScheduledFor(e.target.value)}
									className="rounded-md border border-black/15 px-2 py-1 text-xs"
								/>
							</label>
							<button
								type="button"
								onClick={publish}
								disabled={busy || (cardMode && !bgUrl)}
								className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
							>
								{busy
									? "Publishing…"
									: scheduledFor
										? "Schedule"
										: "Publish now"}
							</button>
							{msg && (
								<span
									className={`text-sm ${
										msg.includes("✓")
											? "text-green-600"
											: busy ||
													msg.includes("ublishing") ||
													msg.includes("cheduling")
												? "opacity-60"
												: "text-red-600"
									}`}
								>
									{msg}
								</span>
							)}
						</div>

						{results.length > 0 && (
							<div className="flex flex-wrap gap-2 text-xs">
								{results.map((p) => {
									const cls =
										p.status === "publishing"
											? "bg-black/10 text-black/60"
											: p.status === "failed"
												? "bg-red-100 text-red-700"
												: "bg-green-100 text-green-700";
									const mark =
										p.status === "publishing"
											? "…"
											: p.status === "failed"
												? "✗"
												: p.status === "scheduled"
													? "⏱"
													: "✓";
									return (
										<span
											key={p.platform}
											className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${cls}`}
											title={p.error}
										>
											{p.platform} {mark}
											{p.url && (
												<a
													href={p.url}
													target="_blank"
													rel="noopener noreferrer"
													className="underline hover:no-underline"
												>
													View ↗
												</a>
											)}
										</span>
									);
								})}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
