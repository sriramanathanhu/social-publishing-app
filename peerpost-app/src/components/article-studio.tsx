"use client";

import { useRef, useState } from "react";
import { ArticlePublish } from "@/components/article-publish";
import type { Ecosystem } from "@/components/publish-row";
import { RichEditor } from "@/components/rich-editor";
import { DUB_LANGUAGES } from "@/lib/dub-options";

// Output languages — the same 15 as dubbing (plus the default/source language).
const ARTICLE_LANGUAGES = ["", ...DUB_LANGUAGES.map((l) => l.label)];

const LENGTHS = [
	{ value: "short", label: "Short (~700w)" },
	{ value: "medium", label: "Medium (~1300w)" },
	{ value: "long", label: "Long (~2200w)" },
] as const;

const TONES = ["", "devotional", "reflective", "scholarly", "journalistic"];

export type Citation = { n: number; file: string; uri: string };
export type Article = {
	id: string;
	topic: string;
	title: string | null;
	content: string;
	citations: Citation[] | null;
	provider: string | null;
	createdAt: string | Date;
};

/** Minimal, safe Markdown renderer for headings / bold / lists / paragraphs. */
function Markdown({ text }: { text: string }) {
	const lines = text.split("\n");
	const out: React.ReactNode[] = [];
	let list: string[] = [];
	const flush = (key: string) => {
		if (list.length) {
			out.push(
				<ul key={key} className="my-2 list-disc space-y-1 pl-6">
					{list.map((li, i) => (
						<li key={`${key}-${i}`}>{inline(li)}</li>
					))}
				</ul>,
			);
			list = [];
		}
	};
	const inline = (s: string): React.ReactNode =>
		s.split(/(\*\*[^*]+\*\*|\[\d+(?:\s*,\s*\d+)*\])/g).map((part, i) => {
			if (part.startsWith("**") && part.endsWith("**"))
				return <strong key={i}>{part.slice(2, -2)}</strong>;
			if (/^\[\d+(?:\s*,\s*\d+)*\]$/.test(part))
				return (
					<sup key={i} className="text-[0.65em] text-slate-400">
						{part}
					</sup>
				);
			return <span key={i}>{part}</span>;
		});
	lines.forEach((raw, idx) => {
		const line = raw.trimEnd();
		if (/^#\s+/.test(line)) {
			flush(`f${idx}`);
			out.push(
				<h1 key={idx} className="mt-2 mb-3 font-bold text-2xl">
					{inline(line.replace(/^#\s+/, ""))}
				</h1>,
			);
		} else if (/^##\s+/.test(line)) {
			flush(`f${idx}`);
			out.push(
				<h2 key={idx} className="mt-5 mb-2 font-semibold text-xl">
					{inline(line.replace(/^##\s+/, ""))}
				</h2>,
			);
		} else if (/^###\s+/.test(line)) {
			flush(`f${idx}`);
			out.push(
				<h3 key={idx} className="mt-4 mb-2 font-semibold text-lg">
					{inline(line.replace(/^###\s+/, ""))}
				</h3>,
			);
		} else if (/^[-*]\s+/.test(line)) {
			list.push(line.replace(/^[-*]\s+/, ""));
		} else if (line.trim() === "") {
			flush(`f${idx}`);
		} else {
			flush(`f${idx}`);
			out.push(
				<p key={idx} className="my-2 leading-relaxed">
					{inline(line)}
				</p>,
			);
		}
	});
	flush("end");
	return <div className="text-slate-800 text-sm">{out}</div>;
}

export function ArticleStudio({
	initialArticles,
	ecosystems,
	corpusReady,
}: {
	initialArticles: Article[];
	ecosystems: Ecosystem[];
	corpusReady: boolean;
}) {
	const [articles, setArticles] = useState<Article[]>(initialArticles);
	const [selectedId, setSelectedId] = useState<string | null>(
		initialArticles[0]?.id ?? null,
	);
	const [topic, setTopic] = useState("");
	const [length, setLength] = useState<"short" | "medium" | "long">("medium");
	const [tone, setTone] = useState("");
	const [quality, setQuality] = useState<"standard" | "high">("standard");
	const [outputLang, setOutputLang] = useState("");
	const [instructions, setInstructions] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
	const [showGenerate, setShowGenerate] = useState(
		initialArticles.length === 0,
	);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

	const selected = articles.find((a) => a.id === selectedId) ?? null;

	async function generate() {
		if (topic.trim().length < 3) return;
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/articles", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					topic: topic.trim(),
					length,
					tone: tone || undefined,
					quality,
					outputLang: outputLang || undefined,
					instructions: instructions.trim() || undefined,
				}),
			});
			const data = await res.json();
			if (!res.ok) {
				const fieldErrors = data?.details?.fieldErrors as
					| Record<string, string[]>
					| undefined;
				const detail = fieldErrors
					? Object.entries(fieldErrors)
							.map(([k, v]) => `${k} ${v.join(", ")}`)
							.join("; ")
					: null;
				throw new Error(detail || data.error || "Generation failed");
			}
			setArticles((prev) => [data.article, ...prev]);
			setSelectedId(data.article.id);
			setTopic("");
			setEditing(false);
			setShowGenerate(false);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Generation failed");
		} finally {
			setBusy(false);
		}
	}

	function patch(id: string, body: { title?: string; content?: string }) {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		saveTimer.current = setTimeout(() => {
			fetch(`/api/articles/${id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			}).catch(() => {});
		}, 700);
	}

	function update(id: string, body: { title?: string; content?: string }) {
		setArticles((prev) =>
			prev.map((a) => (a.id === id ? { ...a, ...body } : a)),
		);
		patch(id, body);
	}

	async function remove(id: string) {
		setArticles((prev) => prev.filter((a) => a.id !== id));
		if (selectedId === id) setSelectedId(null);
		await fetch(`/api/articles/${id}`, { method: "DELETE" }).catch(() => {});
	}

	// Strip inline citation markers ([1], [1, 6]) and tidy the leftover spacing,
	// so copied text reads cleanly without the source numbers.
	function stripCitations(md: string): string {
		return md
			.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
			.replace(/[ \t]{2,}/g, " ")
			.replace(/ +([.,;:!?])/g, "$1")
			.trim();
	}

	function download(a: Article) {
		const blob = new Blob([a.content], { type: "text/markdown" });
		const url = URL.createObjectURL(blob);
		const link = document.createElement("a");
		link.href = url;
		link.download = `${(a.title || a.topic).replace(/[^\w-]+/g, "-").slice(0, 60)}.md`;
		link.click();
		URL.revokeObjectURL(url);
	}

	return (
		<div className="flex h-full flex-col">
			{/* Header */}
			<div className="flex items-center justify-between gap-4 border-slate-200 border-b px-6 py-3">
				<div>
					<h1 className="font-bold text-slate-900 text-xl">Articles</h1>
					<p className="text-slate-500 text-xs">
						Grounded long-form writing from your corpus — edit and publish to
						LinkedIn, Facebook, Reddit, or X.
					</p>
				</div>
				<button
					type="button"
					onClick={() => setShowGenerate((v) => !v)}
					className="shrink-0 rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white"
				>
					{showGenerate ? "Close" : "+ New article"}
				</button>
			</div>

			{/* Generate panel (collapsible) */}
			{showGenerate && (
				<div className="border-slate-200 border-b bg-slate-50 px-6 py-4">
					{!corpusReady && (
						<div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800 text-sm">
							The corpus (Vertex AI Search) isn't configured yet, so generation
							is disabled.
						</div>
					)}
					<textarea
						value={topic}
						onChange={(e) => setTopic(e.target.value)}
						placeholder="Topic or title — e.g. 'The words that shaped your identity'"
						className="w-full resize-none rounded-lg border border-slate-300 p-3 text-sm focus:border-slate-500 focus:outline-none"
						rows={2}
					/>
					<textarea
						value={instructions}
						onChange={(e) => setInstructions(e.target.value)}
						placeholder="Optional instructions — e.g. 'Add a 200-character summary with a call-to-action at the top, and a guided meditation at the end.' Followed exactly."
						className="mt-2 w-full resize-none rounded-lg border border-slate-300 p-3 text-sm focus:border-slate-500 focus:outline-none"
						rows={2}
					/>
					<div className="mt-3 flex flex-wrap items-center gap-3">
						<select
							value={length}
							onChange={(e) => setLength(e.target.value as typeof length)}
							className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
						>
							{LENGTHS.map((l) => (
								<option key={l.value} value={l.value}>
									{l.label}
								</option>
							))}
						</select>
						<select
							value={tone}
							onChange={(e) => setTone(e.target.value)}
							className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
						>
							{TONES.map((t) => (
								<option key={t} value={t}>
									{t ? `Tone: ${t}` : "Default tone"}
								</option>
							))}
						</select>
						<select
							value={quality}
							onChange={(e) =>
								setQuality(e.target.value as "standard" | "high")
							}
							className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
							title="High quality uses Gemini 2.5 Pro — deeper, but slower"
						>
							<option value="standard">Standard (fast)</option>
							<option value="high">High quality (Pro)</option>
						</select>
						<select
							value={outputLang}
							onChange={(e) => setOutputLang(e.target.value)}
							className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
							title="Write the article in this language"
						>
							{ARTICLE_LANGUAGES.map((l) => (
								<option key={l || "default"} value={l}>
									{l || "Default language"}
								</option>
							))}
						</select>
						<button
							type="button"
							onClick={generate}
							disabled={busy || !corpusReady || topic.trim().length < 3}
							className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40"
						>
							{busy ? "Writing…" : "Generate article"}
						</button>
						{busy && (
							<span className="text-slate-400 text-sm">
								Researching the corpus and writing — up to a minute…
							</span>
						)}
						{error && <span className="text-red-600 text-sm">{error}</span>}
					</div>
				</div>
			)}

			{/* Split: list rail + full-width detail */}
			<div className="flex min-h-0 flex-1">
				<aside className="w-60 shrink-0 overflow-y-auto border-slate-200 border-r">
					<div className="px-3 py-2 font-medium text-slate-400 text-xs uppercase tracking-wide">
						{articles.length} saved
					</div>
					{articles.map((a) => (
						<button
							type="button"
							key={a.id}
							onClick={() => {
								setSelectedId(a.id);
								setEditing(false);
							}}
							className={`block w-full truncate border-slate-100 border-b px-3 py-2.5 text-left text-sm ${
								a.id === selectedId
									? "bg-slate-100 font-medium text-slate-900"
									: "text-slate-600 hover:bg-slate-50"
							}`}
						>
							{a.title || a.topic}
						</button>
					))}
					{articles.length === 0 && (
						<p className="px-3 py-2 text-slate-400 text-sm">No articles yet.</p>
					)}
				</aside>

				<main className="min-w-0 flex-1 overflow-y-auto">
					{selected ? (
						<div className="px-8 py-6">
							{/* Title + actions */}
							<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
								<input
									value={selected.title ?? ""}
									onChange={(e) =>
										update(selected.id, { title: e.target.value })
									}
									className="min-w-0 flex-1 rounded-lg border border-transparent px-1 py-1 font-bold text-slate-900 text-xl hover:border-slate-200 focus:border-slate-300 focus:outline-none"
								/>
								<div className="flex items-center gap-2 text-xs">
									{selected.provider && (
										<span className="rounded bg-slate-100 px-2 py-1 text-slate-500">
											{selected.provider}
										</span>
									)}
									<button
										type="button"
										onClick={() => setEditing((v) => !v)}
										className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
									>
										{editing ? "Preview" : "Edit"}
									</button>
									<button
										type="button"
										onClick={() =>
											navigator.clipboard.writeText(
												stripCitations(selected.content),
											)
										}
										className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
									>
										Copy
									</button>
									<button
										type="button"
										onClick={() => download(selected)}
										className="rounded border border-slate-300 px-2 py-1 hover:bg-slate-50"
									>
										Download
									</button>
									<button
										type="button"
										onClick={() => remove(selected.id)}
										className="rounded border border-red-200 px-2 py-1 text-red-600 hover:bg-red-50"
									>
										Delete
									</button>
								</div>
							</div>

							{selected.provider === "nvidia" && (
								<div className="mb-3 rounded-lg border border-amber-300 bg-amber-50 p-2.5 text-amber-800 text-xs">
									Generated with the fallback model (NVIDIA) — your Gemini key
									was unavailable or rate-limited. For deeper results, check
									your Gemini key in Settings or regenerate with “High quality”.
								</div>
							)}

							{editing ? (
								<RichEditor
									key={selected.id}
									markdown={selected.content}
									onChange={(md) => update(selected.id, { content: md })}
								/>
							) : (
								<article className="max-w-none">
									<Markdown text={selected.content} />
								</article>
							)}

							{selected.citations && selected.citations.length > 0 && (
								<div className="mt-6 border-slate-200 border-t pt-3">
									<div className="mb-2 font-medium text-slate-400 text-xs uppercase tracking-wide">
										Sources ({selected.citations.length})
									</div>
									<ul className="space-y-1 text-slate-500 text-xs">
										{selected.citations.map((c) => (
											<li key={c.n}>
												<span className="text-slate-400">[{c.n}]</span> {c.file}
											</li>
										))}
									</ul>
								</div>
							)}

							<div className="mt-6">
								<ArticlePublish
									key={selected.id}
									article={selected}
									ecosystems={ecosystems}
								/>
							</div>
						</div>
					) : (
						<div className="flex h-full items-center justify-center p-10 text-center text-slate-400 text-sm">
							Generate an article or pick one from the list.
						</div>
					)}
				</main>
			</div>
		</div>
	);
}
