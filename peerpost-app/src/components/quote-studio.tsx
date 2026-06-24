"use client";

import { useState } from "react";
import type { Ecosystem } from "@/components/publish-row";
import { QuoteBatchPanel } from "@/components/quote-batch-panel";
import { QuoteRow } from "@/components/quote-row";
import type {
	QuoteBackground,
	QuoteItem,
	QuoteOverlay,
} from "@/components/quote-types";

const TONES = [
	"",
	"devotional",
	"bold & provocative",
	"reflective",
	"motivational",
	"scholarly",
];

// Output languages (the card renderer has fonts for all of these scripts).
const LANGUAGES = [
	"",
	"English",
	"Hindi",
	"Tamil",
	"Telugu",
	"Kannada",
	"Malayalam",
	"Bengali",
	"Gujarati",
	"Marathi",
	"Bhojpuri",
	"Punjabi",
	"Russian",
	"Spanish",
	"French",
	"Dutch",
	"Korean",
	"Chinese (Mandarin)",
];

/**
 * Paste long-form content → AI distills several powerful quotes (Gemini → NVIDIA
 * fallback). Quotes are SAVED, so the set + any rendered cards survive a refresh.
 * Each can be posted as text or a branded image card; regenerate one, append
 * more, or batch-schedule the whole set.
 */
type TranscriptOption = { id: string; title: string; transcript: string };

export function QuoteStudio({
	ecosystems,
	backgrounds,
	overlays,
	initialItems,
	transcripts,
}: {
	ecosystems: Ecosystem[];
	backgrounds: QuoteBackground[];
	overlays: QuoteOverlay[];
	initialItems: QuoteItem[];
	transcripts: TranscriptOption[];
}) {
	const [content, setContent] = useState("");
	const [showTranscripts, setShowTranscripts] = useState(false);
	const [count, setCount] = useState(6);
	const [tone, setTone] = useState("");
	const [outputLang, setOutputLang] = useState("");
	const [busy, setBusy] = useState(false);
	const [moreBusy, setMoreBusy] = useState(false);
	const [regenId, setRegenId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [provider, setProvider] = useState<string | null>(null);
	const [items, setItems] = useState<QuoteItem[]>(initialItems);
	const [view, setView] = useState<"single" | "batch">("single");

	async function fetchQuotes(
		n: number,
		avoid: string[],
		batchId?: string | null,
	): Promise<QuoteItem[]> {
		const res = await fetch("/api/quotes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				count: n,
				tone: tone || undefined,
				avoid: avoid.length ? avoid : undefined,
				outputLang: outputLang || undefined,
				batchId: batchId || undefined,
			}),
		});
		const d = await res.json().catch(() => ({}));
		if (!res.ok) {
			const fields = d.details?.fieldErrors
				? Object.entries(d.details.fieldErrors)
						.map(([k, v]) => `${k}: ${(v as string[]).join(", ")}`)
						.join(" · ")
				: "";
			throw new Error(fields || d.error || "Generation failed");
		}
		setProvider(d.provider ?? null);
		return ((d.quotes ?? []) as QuoteItem[]).map((q) => ({
			...q,
			hashtags: q.hashtags ?? [],
			bgUrl: q.bgUrl ?? null,
			overlayUrl: q.overlayUrl ?? null,
			cardUrl: q.cardUrl ?? null,
			panY: q.panY ?? 0.4,
			zoom: q.zoom ?? 1,
			batchId: q.batchId ?? null,
		}));
	}

	function patchLocal(id: string, patch: Partial<QuoteItem>) {
		setItems((prev) => prev.map((q) => (q.id === id ? { ...q, ...patch } : q)));
	}

	async function generate() {
		if (content.trim().length < 40) {
			setError("Paste at least a paragraph of content to work from.");
			return;
		}
		setBusy(true);
		setError(null);
		try {
			const fresh = await fetchQuotes(count, []);
			setItems((prev) => [...fresh, ...prev]);
			if (fresh.length === 0)
				setError("No quotes were generated — try more content.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	async function moreLikeThis() {
		setMoreBusy(true);
		setError(null);
		try {
			const more = await fetchQuotes(
				3,
				items.map((q) => q.text),
			);
			setItems((prev) => [...prev, ...more]);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setMoreBusy(false);
		}
	}

	async function regenerate(id: string) {
		setRegenId(id);
		setError(null);
		try {
			// Keep the replacement in the same batch as the quote it replaces.
			const origBatch = items.find((q) => q.id === id)?.batchId ?? null;
			const [fresh] = await fetchQuotes(
				1,
				items.map((q) => q.text),
				origBatch,
			);
			if (fresh) {
				setItems((prev) => prev.map((q) => (q.id === id ? fresh : q)));
				fetch(`/api/quotes/items/${id}`, { method: "DELETE" }).catch(() => {});
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setRegenId(null);
		}
	}

	function removeItem(id: string) {
		setItems((prev) => prev.filter((q) => q.id !== id));
		fetch(`/api/quotes/items/${id}`, { method: "DELETE" }).catch(() => {});
	}

	return (
		<div className="space-y-4">
			{showTranscripts && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
					onClick={() => setShowTranscripts(false)}
					onKeyDown={(e) => e.key === "Escape" && setShowTranscripts(false)}
					role="presentation"
				>
					<div
						className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white p-4 shadow-xl"
						onClick={(e) => e.stopPropagation()}
						role="presentation"
					>
						<div className="mb-3 flex items-center justify-between">
							<h3 className="font-semibold text-sm">Select a transcript</h3>
							<button
								type="button"
								onClick={() => setShowTranscripts(false)}
								className="rounded-md border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5"
							>
								Close
							</button>
						</div>
						{transcripts.length === 0 ? (
							<p className="text-sm opacity-60">
								No finished transcripts yet. Create one under Content →
								Transcribe.
							</p>
						) : (
							<div className="space-y-1 overflow-y-auto">
								{transcripts.map((t) => (
									<button
										type="button"
										key={t.id}
										onClick={() => {
											setContent(t.transcript);
											setShowTranscripts(false);
										}}
										className="block w-full rounded-md border border-black/10 px-3 py-2 text-left text-sm hover:bg-black/5"
									>
										<div className="font-medium">{t.title}</div>
										<div className="truncate text-xs opacity-50">
											{t.transcript.length.toLocaleString()} chars ·{" "}
											{t.transcript.slice(0, 80)}…
										</div>
									</button>
								))}
							</div>
						)}
					</div>
				</div>
			)}
			<div className="space-y-3 rounded-xl border border-black/10 bg-white p-5 shadow-sm">
				<div>
					<div className="flex items-center justify-between">
						<label
							className="block text-xs font-medium opacity-60"
							htmlFor="src"
						>
							Long-form content
						</label>
						<button
							type="button"
							onClick={() => setShowTranscripts(true)}
							className="rounded-md border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5"
						>
							Select transcript
						</button>
					</div>
					<textarea
						id="src"
						value={content}
						onChange={(e) => setContent(e.target.value)}
						rows={6}
						placeholder="Paste a talk transcript, article, or any long passage. The AI distills the strongest standalone quotes from it."
						className="mt-1 w-full resize-y rounded-md border border-black/15 px-3 py-2 text-sm"
					/>
					<p className="mt-1 text-xs opacity-50">
						{content.trim().length} characters
					</p>
				</div>
				<div className="flex flex-wrap items-end gap-3">
					<label className="block text-xs font-medium opacity-60">
						Quotes
						<input
							type="number"
							min={1}
							max={50}
							value={count}
							onChange={(e) => setCount(Number(e.target.value))}
							className="mt-1 w-20 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
						/>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Tone
						<select
							value={tone}
							onChange={(e) => setTone(e.target.value)}
							className="mt-1 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
						>
							{TONES.map((t) => (
								<option key={t || "auto"} value={t}>
									{t || "Auto"}
								</option>
							))}
						</select>
					</label>
					<label className="block text-xs font-medium opacity-60">
						Output language
						<select
							value={outputLang}
							onChange={(e) => setOutputLang(e.target.value)}
							className="mt-1 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
						>
							{LANGUAGES.map((l) => (
								<option key={l || "same"} value={l}>
									{l || "Same as content"}
								</option>
							))}
						</select>
					</label>
					<button
						type="button"
						onClick={generate}
						disabled={busy}
						className="ml-auto h-10 rounded-md bg-primary px-5 text-sm font-medium text-white disabled:opacity-50"
					>
						{busy ? "Generating…" : "Generate quotes"}
					</button>
				</div>
				{error && <p className="text-sm text-red-600">{error}</p>}
				<p className="text-xs opacity-40">
					Uses your Gemini key, falling back to NVIDIA — add them under Settings
					→ Service keys.
				</p>
			</div>

			{items.length > 0 && (
				<div className="space-y-3">
					<div className="flex items-center justify-between gap-2">
						<h2 className="flex items-center gap-2 text-sm font-semibold opacity-70">
							{items.length} saved quotes
							{provider && (
								<span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] font-normal uppercase opacity-60">
									{provider}
								</span>
							)}
						</h2>
						<div className="inline-flex rounded-md border border-black/15 p-0.5 text-xs">
							{(["single", "batch"] as const).map((v) => (
								<button
									type="button"
									key={v}
									onClick={() => setView(v)}
									className={`rounded px-2.5 py-1 ${view === v ? "bg-primary text-white" : "opacity-70 hover:opacity-100"}`}
								>
									{v === "batch" ? "⚡ Batch & schedule" : "Single"}
								</button>
							))}
						</div>
					</div>

					{view === "batch" && (
						<QuoteBatchPanel
							items={items}
							backgrounds={backgrounds}
							overlays={overlays}
							ecosystems={ecosystems}
							onChange={patchLocal}
						/>
					)}

					{view === "single" &&
						items.map((q) => (
							<QuoteRow
								key={q.id}
								item={q}
								ecosystems={ecosystems}
								backgrounds={backgrounds}
								overlays={overlays}
								tone={tone || undefined}
								regenerating={regenId === q.id}
								onRegenerate={() => regenerate(q.id)}
								onDelete={() => removeItem(q.id)}
								onChange={(patch) => patchLocal(q.id, patch)}
							/>
						))}

					<button
						type="button"
						onClick={moreLikeThis}
						disabled={moreBusy}
						className="rounded-md border border-black/15 px-4 py-2 text-sm hover:bg-black/5 disabled:opacity-50"
					>
						{moreBusy ? "Generating…" : "+ More like this"}
					</button>
				</div>
			)}
		</div>
	);
}
