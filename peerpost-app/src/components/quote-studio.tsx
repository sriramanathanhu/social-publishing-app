"use client";

import { useEffect, useState } from "react";
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
	"Swahili",
	"Gujarati",
	"Marathi",
	"Bhojpuri",
	"Punjabi",
	"Russian",
	"Spanish",
	"French",
	"Dutch",
	"Korean",
	"Portuguese",
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
	// Output languages: empty = "same as content"; one batch is generated per
	// selected language (queued, one after another).
	const [langs, setLangs] = useState<string[]>([]);
	const [queueMsg, setQueueMsg] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [moreBusy, setMoreBusy] = useState(false);
	const [regenId, setRegenId] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [provider, setProvider] = useState<string | null>(null);
	const [items, setItems] = useState<QuoteItem[]>(initialItems);
	const [view, setView] = useState<"single" | "batch">("single");
	const [page, setPage] = useState(0);
	const [autoMsg, setAutoMsg] = useState<string | null>(null);
	// Saved distribution lists (for the "Generate & distribute" action).
	const [distributions, setDistributions] = useState<
		{ id: string; name: string; targets: unknown[]; cardsPerTarget: number }[]
	>([]);
	const [distId, setDistId] = useState("");

	// Load the user's distribution lists, and refresh when one is saved in the
	// panel (custom event) or the tab regains focus — so a newly-created list
	// shows up here without a page reload.
	useEffect(() => {
		const load = () =>
			fetch("/api/quotes/distributions")
				.then((r) => r.json())
				.then((d) => setDistributions(d.distributions ?? []))
				.catch(() => {});
		load();
		window.addEventListener("focus", load);
		window.addEventListener("quotes:distributions-changed", load);
		return () => {
			window.removeEventListener("focus", load);
			window.removeEventListener("quotes:distributions-changed", load);
		};
	}, []);

	async function fetchQuotes(
		n: number,
		avoid: string[],
		batchId?: string | null,
		lang?: string,
	): Promise<QuoteItem[]> {
		const res = await fetch("/api/quotes", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content,
				count: n,
				tone: tone || undefined,
				avoid: avoid.length ? avoid : undefined,
				outputLang: (lang ?? "") || undefined,
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
			outputLang: q.outputLang ?? (lang || null),
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
		// One batch per selected language (queued); empty selection = one default.
		const targets = langs.length ? langs : [""];
		setBusy(true);
		setError(null);
		let total = 0;
		try {
			for (let i = 0; i < targets.length; i++) {
				const lang = targets[i];
				if (targets.length > 1)
					setQueueMsg(
						`Generating ${lang || "default"} … (${i + 1}/${targets.length})`,
					);
				const fresh = await fetchQuotes(count, [], undefined, lang);
				total += fresh.length;
				setItems((prev) => [...fresh, ...prev]);
			}
			setPage(0); // newest (prepended) quotes are on the first page
			if (total === 0) setError("No quotes were generated — try more content.");
			else if (targets.length > 1) setView("batch");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
			setQueueMsg(null);
		}
	}

	/**
	 * One click: for each language that has a quote rule, generate `count` quotes,
	 * render each into a card (rotating library backgrounds + the default overlay),
	 * and schedule every card to that language's mapped accounts — first one
	 * `buffer` min out, then one every `gap` min (drip). Reuses the same
	 * generate / card-render / schedule endpoints as the manual flow.
	 */
	async function generateAndAutoSchedule() {
		if (content.trim().length < 40) {
			setError("Paste at least a paragraph of content to work from.");
			return;
		}
		setBusy(true);
		setError(null);
		setAutoMsg(null);
		setQueueMsg(
			langs.length
				? `Generating & scheduling · ${langs.length} language(s)…`
				: "Generating & scheduling all mapped languages…",
		);
		try {
			// ONE server call does generate + render + schedule for every language
			// that has a rule — a single auth check. (The old client flow fired a
			// burst of authenticated requests, each re-validating the SSO session
			// over the network, which Nandi rate-limited → "Not authenticated".)
			const res = await fetch("/api/quotes/auto-publish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content,
					count,
					tone: tone || undefined,
					languages: langs.length ? langs : undefined,
				}),
			});
			const d = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(d.error ?? "Auto-schedule failed");
			if (d.error) {
				setError(d.error);
				return;
			}
			if (d.items?.length) {
				setItems((prev) => [...(d.items as QuoteItem[]), ...prev]);
				setView("batch");
				setPage(0);
			}
			setAutoMsg(
				`Scheduled ${d.scheduled} card post(s) across ${d.languages.length} language(s)${
					d.failed ? ` · ${d.failed} failed` : ""
				}. They appear in Scheduled, spaced by each rule's gap.`,
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
			setQueueMsg(null);
		}
	}

	/**
	 * Generate a pool of `count` cards and SPREAD them across a saved
	 * distribution list — a distinct slice per target account (no repeats),
	 * drip-spaced. One server call.
	 */
	async function generateAndDistribute() {
		if (content.trim().length < 40) {
			setError("Paste at least a paragraph of content to work from.");
			return;
		}
		if (!distId) {
			setError("Pick a distribution list (or create one above).");
			return;
		}
		setBusy(true);
		setError(null);
		setAutoMsg(null);
		setQueueMsg(`Generating ${count} & distributing…`);
		try {
			const res = await fetch("/api/quotes/distribute", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content,
					count,
					tone: tone || undefined,
					distributionId: distId,
				}),
			});
			const d = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(d.error ?? "Distribute failed");
			if (d.error) {
				setError(d.error);
				return;
			}
			if (d.items?.length) {
				setItems((prev) => [...(d.items as QuoteItem[]), ...prev]);
				setView("batch");
				setPage(0);
			}
			setAutoMsg(
				`Generated ${d.generated}, scheduled ${d.scheduled} card post(s) across ${d.targets} account(s)${
					d.failed ? ` · ${d.failed} failed` : ""
				}. Each account got its own slice — see Scheduled.`,
			);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
			setQueueMsg(null);
		}
	}

	async function moreLikeThis() {
		setMoreBusy(true);
		setError(null);
		try {
			const more = await fetchQuotes(
				3,
				items.map((q) => q.text),
				undefined,
				langs[0] ?? "",
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
			// Keep the replacement in the same batch + language as the quote it replaces.
			const orig = items.find((q) => q.id === id);
			const [fresh] = await fetchQuotes(
				1,
				items.map((q) => q.text),
				orig?.batchId ?? null,
				orig?.outputLang ?? "",
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
					<div className="text-xs font-medium opacity-60">
						Output languages
						<div className="mt-1 flex flex-wrap items-center gap-1">
							{langs.map((l) => (
								<span
									key={l}
									className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-1 text-xs text-primary"
								>
									{l}
									<button
										type="button"
										onClick={() => setLangs((p) => p.filter((x) => x !== l))}
										className="leading-none hover:opacity-70"
										aria-label={`Remove ${l}`}
									>
										×
									</button>
								</span>
							))}
							<select
								value=""
								onChange={(e) => {
									const v = e.target.value;
									if (v && !langs.includes(v)) setLangs((p) => [...p, v]);
								}}
								className="rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
							>
								<option value="">
									{langs.length ? "+ Add language" : "Same as content"}
								</option>
								{LANGUAGES.filter((l) => l && !langs.includes(l)).map((l) => (
									<option key={l} value={l}>
										{l}
									</option>
								))}
							</select>
						</div>
					</div>
					<div className="ml-auto flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={generate}
							disabled={busy}
							className="h-10 rounded-md bg-primary px-5 text-sm font-medium text-white disabled:opacity-50"
						>
							{busy
								? (queueMsg ?? "Generating…")
								: langs.length > 1
									? `Generate · ${langs.length} languages`
									: "Generate quotes"}
						</button>
						<button
							type="button"
							onClick={generateAndAutoSchedule}
							disabled={busy}
							title="Generate, render cards, and schedule each language to its mapped accounts by your Quote auto-publish rules"
							className="h-10 rounded-md border border-primary bg-primary/10 px-4 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
						>
							{busy ? (queueMsg ?? "Working…") : "⚡ Generate & auto-schedule"}
						</button>
					</div>
				</div>
				{distributions.length > 0 && (
					<div className="flex flex-wrap items-center gap-2 border-t border-black/10 pt-3">
						<span className="text-xs font-medium opacity-60">
							Distribute mode:
						</span>
						<select
							value={distId}
							onChange={(e) => setDistId(e.target.value)}
							className="rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
						>
							<option value="">Pick a distribution list…</option>
							{distributions.map((d) => (
								<option key={d.id} value={d.id}>
									{d.name} ({d.targets.length} accounts · {d.cardsPerTarget}/ea)
								</option>
							))}
						</select>
						<button
							type="button"
							onClick={generateAndDistribute}
							disabled={busy || !distId}
							title="Generate a pool of cards and spread a distinct slice to each account in the list (no repeats)"
							className="h-9 rounded-md border border-primary bg-primary/10 px-4 text-sm font-medium text-primary hover:bg-primary/15 disabled:opacity-50"
						>
							{busy ? (queueMsg ?? "Working…") : "⚡ Generate & distribute"}
						</button>
						<span className="text-xs opacity-50">
							Spreads {count} cards · 10 per account, no repeats
						</span>
					</div>
				)}
				{autoMsg && (
					<p className="rounded-md border border-green-300 bg-green-50 px-3 py-2 text-xs text-green-800">
						{autoMsg}
					</p>
				)}
				{langs.length > 1 && (
					<p className="text-xs opacity-50">
						Generates {count} quotes in each of {langs.length} languages —
						queued one after another, each as its own batch you can render &
						schedule separately.
					</p>
				)}
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
						(() => {
							const PAGE = 5;
							const pageCount = Math.ceil(items.length / PAGE);
							const cur = Math.min(page, pageCount - 1);
							const visible = items.slice(cur * PAGE, cur * PAGE + PAGE);
							return (
								<>
									{visible.map((q) => (
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
									{pageCount > 1 && (
										<div className="flex items-center justify-center gap-3 text-sm">
											<button
												type="button"
												onClick={() => setPage((p) => Math.max(0, p - 1))}
												disabled={cur === 0}
												className="rounded-md border border-black/15 px-2.5 py-1 hover:bg-black/5 disabled:opacity-40"
											>
												‹ Prev
											</button>
											<span className="opacity-60">
												Page {cur + 1} of {pageCount}
											</span>
											<button
												type="button"
												onClick={() =>
													setPage((p) => Math.min(pageCount - 1, p + 1))
												}
												disabled={cur >= pageCount - 1}
												className="rounded-md border border-black/15 px-2.5 py-1 hover:bg-black/5 disabled:opacity-40"
											>
												Next ›
											</button>
										</div>
									)}
								</>
							);
						})()}

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
