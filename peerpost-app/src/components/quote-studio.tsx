"use client";

import { useState } from "react";
import type { Ecosystem } from "@/components/publish-row";
import { QuoteRow } from "@/components/quote-row";

type Quote = { text: string; hashtags: string[] };

const TONES = [
	"",
	"devotional",
	"bold & provocative",
	"reflective",
	"motivational",
	"scholarly",
];

/**
 * Paste long-form content → AI distills several powerful, postable quotes
 * (Gemini, NVIDIA fallback). Each quote publishes/schedules inline below.
 */
export function QuoteStudio({ ecosystems }: { ecosystems: Ecosystem[] }) {
	const [content, setContent] = useState("");
	const [count, setCount] = useState(6);
	const [tone, setTone] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [provider, setProvider] = useState<string | null>(null);
	const [quotes, setQuotes] = useState<Quote[]>([]);

	async function generate() {
		if (content.trim().length < 40) {
			setError("Paste at least a paragraph of content to work from.");
			return;
		}
		setBusy(true);
		setError(null);
		setQuotes([]);
		setProvider(null);
		try {
			const res = await fetch("/api/quotes", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ content, count, tone: tone || undefined }),
			});
			const d = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(d.error ?? "Generation failed");
			setQuotes(d.quotes ?? []);
			setProvider(d.provider ?? null);
			if ((d.quotes ?? []).length === 0)
				setError("No quotes were generated — try more content.");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-4">
			<div className="space-y-3 rounded-xl border border-black/10 bg-white p-5 shadow-sm">
				<div>
					<label className="block text-xs font-medium opacity-60" htmlFor="src">
						Long-form content
					</label>
					<textarea
						id="src"
						value={content}
						onChange={(e) => setContent(e.target.value)}
						rows={8}
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
							max={15}
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

			{quotes.length > 0 && (
				<div className="space-y-3">
					<h2 className="flex items-center gap-2 text-sm font-semibold opacity-70">
						{quotes.length} quotes
						{provider && (
							<span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] font-normal uppercase opacity-60">
								{provider}
							</span>
						)}
					</h2>
					{quotes.map((q, i) => (
						<QuoteRow
							key={`${i}-${q.text.slice(0, 24)}`}
							initialText={q.text}
							hashtags={q.hashtags}
							ecosystems={ecosystems}
						/>
					))}
				</div>
			)}
		</div>
	);
}
