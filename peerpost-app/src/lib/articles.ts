import "server-only";
import { type CorpusPassage, searchCorpus } from "@/lib/vertex-search";

/**
 * Long-form article generation grounded on the Vertex AI Search corpus.
 *
 * Pipeline (to approach NotebookLM-style depth):
 *  1. Plan an outline (cheap Flash call) — doubles as multi-query search terms.
 *  2. Retrieve passages for the topic + each outline heading in parallel, then
 *     merge/dedupe — broader, richer grounding than a single query.
 *  3. Write the article from all gathered passages with a structure-forcing
 *     prompt (define terms, explain mechanism, step-by-step techniques,
 *     conclusion). Auto-continue if the model truncates.
 */

const FLASH = "gemini-2.5-flash";
const PRO = "gemini-2.5-pro";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";

const WORDS: Record<string, number> = { short: 800, medium: 1400, long: 2400 };
const SECTIONS: Record<string, number> = { short: 4, medium: 6, long: 8 };

export type Citation = { n: number; file: string; uri: string };
export type Keys = { geminiKey?: string; nvidiaKey?: string };

type Completion = {
	text: string;
	finish: string;
	provider: "gemini" | "nvidia";
};

async function gemini(
	model: string,
	key: string,
	prompt: string,
	maxTokens: number,
) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.7,
				maxOutputTokens: maxTokens,
				// Disable thinking so reasoning tokens don't eat the output budget
				// and truncate the article.
				thinkingConfig: { thinkingBudget: 0 },
			},
		}),
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok)
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	const d = await res.json();
	const cand = d?.candidates?.[0];
	const text =
		cand?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? "";
	return { text, finish: cand?.finishReason ?? "STOP" };
}

async function nvidia(key: string, prompt: string, maxTokens: number) {
	const res = await fetch(NVIDIA_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: NVIDIA_MODEL,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.7,
			max_tokens: maxTokens,
		}),
		signal: AbortSignal.timeout(180_000),
	});
	if (!res.ok)
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	const d = await res.json();
	return {
		text: d?.choices?.[0]?.message?.content ?? "",
		finish: d?.choices?.[0]?.finish_reason ?? "stop",
	};
}

/** One completion, Gemini (chosen model) → NVIDIA fallback. */
async function complete(
	keys: Keys,
	model: string,
	prompt: string,
	maxTokens: number,
): Promise<Completion> {
	const errors: string[] = [];
	if (keys.geminiKey) {
		try {
			const r = await gemini(model, keys.geminiKey, prompt, maxTokens);
			if (r.text.trim()) return { ...r, provider: "gemini" };
		} catch (e) {
			errors.push(`Gemini: ${e instanceof Error ? e.message : e}`);
		}
	}
	if (keys.nvidiaKey) {
		try {
			const r = await nvidia(keys.nvidiaKey, prompt, Math.min(maxTokens, 4096));
			if (r.text.trim()) return { ...r, provider: "nvidia" };
		} catch (e) {
			errors.push(`NVIDIA: ${e instanceof Error ? e.message : e}`);
		}
	}
	throw new Error(errors.join(" | ") || "No model key available");
}

/** Complete, then continue once if the model hit its token cap mid-article. */
async function completeLong(
	keys: Keys,
	model: string,
	prompt: string,
	maxTokens: number,
): Promise<{ text: string; provider: "gemini" | "nvidia" }> {
	const first = await complete(keys, model, prompt, maxTokens);
	let text = first.text.trim();
	let truncated = first.finish === "MAX_TOKENS" || first.finish === "length";
	for (let i = 0; truncated && i < 2; i++) {
		const cont = await complete(
			keys,
			model,
			`${prompt}\n\n---\nThe article so far ends as follows. Continue it from EXACTLY where it stops — do not repeat anything already written, do not restate the title.\n\n…${text.slice(-1200)}`,
			maxTokens,
		);
		const add = cont.text.trim();
		if (!add) break;
		text += (text.endsWith("\n") ? "" : "\n") + add;
		truncated = cont.finish === "MAX_TOKENS" || cont.finish === "length";
	}
	return { text, provider: first.provider };
}

/** Plan section headings (cheap Flash call). Used both to structure and to
 * broaden retrieval. Falls back to an empty outline (topic-only retrieval). */
async function planOutline(
	keys: Keys,
	topic: string,
	tone: string | undefined,
	count: number,
): Promise<string[]> {
	const prompt = `You are planning a long-form, instructive article on the topic "${topic}"${tone ? ` (tone: ${tone})` : ""}, drawn from a corpus of spiritual talks and transcripts.
Propose ${count} section headings that form a coherent teaching arc: define the core concepts, explain the underlying mechanism (cause and effect), give practical step-by-step techniques, and finish with a conclusive synthesis.
Return ONLY a JSON array of short heading strings, nothing else.`;
	try {
		const { text } = await complete(keys, FLASH, prompt, 700);
		const m = text.match(/\[[\s\S]*\]/);
		if (m) {
			const arr = JSON.parse(m[0]);
			if (Array.isArray(arr)) {
				return arr
					.filter((x) => typeof x === "string" && x.trim())
					.slice(0, count);
			}
		}
	} catch {
		// fall through to topic-only retrieval
	}
	return [];
}

/** Retrieve for several queries in parallel and merge/dedupe by source uri. */
async function gatherPassages(queries: string[]): Promise<CorpusPassage[]> {
	const lists = await Promise.all(
		queries.map((q) => searchCorpus(q, { pageSize: 8 }).catch(() => [])),
	);
	const byKey = new Map<string, CorpusPassage>();
	for (const list of lists) {
		for (const p of list) {
			const key = p.uri || p.title;
			const existing = byKey.get(key);
			if (existing) {
				existing.segments = [...new Set([...existing.segments, ...p.segments])];
				existing.snippets = [...new Set([...existing.snippets, ...p.snippets])];
			} else {
				byKey.set(key, { ...p });
			}
		}
	}
	return [...byKey.values()].slice(0, 30);
}

function buildPrompt(
	topic: string,
	outline: string[],
	sources: Citation[],
	sourceText: string[],
	words: number,
	tone?: string,
): string {
	const block = sources
		.map((s, i) => `[${s.n}] (${s.file})\n${sourceText[i]}`)
		.join("\n\n");
	const plan = outline.length
		? `\nSuggested structure (refine headings as needed):\n${outline.map((h, i) => `${i + 1}. ${h}`).join("\n")}\n`
		: "";
	return `You are an expert long-form writer and teacher. Write a comprehensive, deeply instructive article on the topic, grounded STRICTLY in the numbered SOURCE EXCERPTS below (a corpus of spiritual talks and transcripts).

TOPIC: ${topic}
${tone ? `TONE: ${tone}\n` : ""}TARGET LENGTH: about ${words} words.
${plan}
Requirements:
- Open with a short, substantive introduction — no clickbait, no "read on!".
- DEFINE the key terms and concepts precisely, including any Sanskrit terms found in the sources, and explain what each one means.
- Explain the MECHANISM: how and why things work, the cause-and-effect — not just assertions.
- Include a clearly numbered set of practical, STEP-BY-STEP techniques the reader can actually follow.
- End with a CONCLUSIVE synthesis that ties everything into a clear, memorable takeaway.
- Use ONLY information supported by the excerpts; do NOT invent facts, names, or quotes. Where the excerpts are silent, leave it out rather than fabricating.
- Cite sources inline as [n].
- Begin with a "# " title, then use "## " section headings. Return ONLY Markdown — no preamble, no sources list.

SOURCE EXCERPTS:
${block}`;
}

export async function generateArticle(
	topic: string,
	opts: Keys & {
		tone?: string;
		length?: "short" | "medium" | "long";
		quality?: "standard" | "high";
	},
): Promise<{
	title: string;
	content: string;
	citations: Citation[];
	provider: "gemini" | "nvidia";
}> {
	const keys: Keys = { geminiKey: opts.geminiKey, nvidiaKey: opts.nvidiaKey };
	if (!keys.geminiKey && !keys.nvidiaKey) {
		throw new Error(
			"Add a Gemini or NVIDIA API key in Settings → Service keys first.",
		);
	}
	const length = opts.length ?? "medium";
	const words = WORDS[length] ?? 1400;

	// 1) outline (multi-query terms) + 2) parallel retrieval, merged
	const outline = await planOutline(
		keys,
		topic,
		opts.tone,
		SECTIONS[length] ?? 6,
	);
	const passages = await gatherPassages([topic, ...outline]);
	if (passages.length === 0) {
		throw new Error(
			"No relevant material found in the corpus for that topic — try different wording.",
		);
	}
	const sources: Citation[] = passages.map((p, i) => ({
		n: i + 1,
		file:
			(p.uri || p.title || `source ${i + 1}`).split("/").pop() ??
			`source ${i + 1}`,
		uri: p.uri,
	}));
	const sourceText = passages.map((p) =>
		[...p.segments, ...p.snippets]
			.join(" ")
			.replace(/\s+/g, " ")
			.slice(0, 2500),
	);

	// 3) write
	const model = opts.quality === "high" ? PRO : FLASH;
	const maxTokens = Math.min(8192, Math.round(words * 3));
	const prompt = buildPrompt(
		topic,
		outline,
		sources,
		sourceText,
		words,
		opts.tone,
	);
	const { text, provider } = await completeLong(keys, model, prompt, maxTokens);

	const content = text.trim().replace(/^```(?:markdown)?\s*|\s*```$/g, "");
	if (!content) throw new Error("Article generation returned no content.");

	const titleMatch = content.match(/^#\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1].trim() : topic;
	const cited = new Set(
		[...content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
	);
	const citations = cited.size
		? sources.filter((s) => cited.has(s.n))
		: sources;
	return { title, content, citations, provider };
}
