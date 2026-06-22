"use client";

import { useRef, useState } from "react";
import { RichEditor } from "@/components/rich-editor";

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
		s
			.split(/(\*\*[^*]+\*\*)/g)
			.map((part, i) =>
				part.startsWith("**") && part.endsWith("**") ? (
					<strong key={i}>{part.slice(2, -2)}</strong>
				) : (
					<span key={i}>{part}</span>
				),
			);
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
	corpusReady,
}: {
	initialArticles: Article[];
	corpusReady: boolean;
}) {
	const [articles, setArticles] = useState<Article[]>(initialArticles);
	const [selectedId, setSelectedId] = useState<string | null>(
		initialArticles[0]?.id ?? null,
	);
	const [topic, setTopic] = useState("");
	const [length, setLength] = useState<"short" | "medium" | "long">("medium");
	const [tone, setTone] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [editing, setEditing] = useState(false);
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
				}),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error || "Generation failed");
			setArticles((prev) => [data.article, ...prev]);
			setSelectedId(data.article.id);
			setTopic("");
			setEditing(false);
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
		<div className="mx-auto max-w-6xl p-6">
			<header className="mb-4">
				<h1 className="font-bold text-2xl text-slate-900">Articles</h1>
				<p className="mt-1 text-slate-500 text-sm">
					Enter a topic — it pulls the most relevant passages from your uploaded
					corpus and writes a grounded, cited long-form article.
				</p>
			</header>

			{!corpusReady && (
				<div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-amber-800 text-sm">
					The corpus (Vertex AI Search) isn't configured yet, so generation is
					disabled. Set the Google credentials in <code>.env</code> first.
				</div>
			)}

			{/* Generate bar */}
			<div className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
				<textarea
					value={topic}
					onChange={(e) => setTopic(e.target.value)}
					placeholder="Topic or title — e.g. 'What is real meditation and how to begin'"
					className="w-full resize-none rounded-lg border border-slate-300 p-3 text-sm focus:border-slate-500 focus:outline-none"
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
					<button
						type="button"
						onClick={generate}
						disabled={busy || !corpusReady || topic.trim().length < 3}
						className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40"
					>
						{busy ? "Writing…" : "Generate article"}
					</button>
					{error && <span className="text-red-600 text-sm">{error}</span>}
				</div>
			</div>

			<div className="grid grid-cols-1 gap-6 md:grid-cols-[260px_1fr]">
				{/* Saved list */}
				<aside className="space-y-1">
					<div className="mb-2 font-medium text-slate-500 text-xs uppercase tracking-wide">
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
							className={`block w-full truncate rounded-lg px-3 py-2 text-left text-sm ${
								a.id === selectedId
									? "bg-slate-900 text-white"
									: "text-slate-700 hover:bg-slate-100"
							}`}
						>
							{a.title || a.topic}
						</button>
					))}
					{articles.length === 0 && (
						<p className="text-slate-400 text-sm">No articles yet.</p>
					)}
				</aside>

				{/* Detail */}
				{selected ? (
					<section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
						<div className="mb-3 flex flex-wrap items-center justify-between gap-2">
							<input
								value={selected.title ?? ""}
								onChange={(e) => update(selected.id, { title: e.target.value })}
								className="min-w-0 flex-1 rounded-lg border border-transparent px-1 py-1 font-semibold text-lg hover:border-slate-200 focus:border-slate-300 focus:outline-none"
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
								<div className="mb-2 font-medium text-slate-500 text-xs uppercase tracking-wide">
									Sources ({selected.citations.length})
								</div>
								<ul className="space-y-1 text-slate-600 text-xs">
									{selected.citations.map((c) => (
										<li key={c.n}>
											<span className="text-slate-400">[{c.n}]</span> {c.file}
										</li>
									))}
								</ul>
							</div>
						)}
					</section>
				) : (
					<section className="rounded-xl border border-slate-200 border-dashed p-10 text-center text-slate-400 text-sm">
						Generate an article or pick one from the list.
					</section>
				)}
			</div>
		</div>
	);
}
