import "server-only";
import { searchCorpus } from "@/lib/vertex-search";

/**
 * Long-form article generation grounded on the Vertex AI Search corpus:
 * retrieve the most relevant passages for the topic, then have Gemini (NVIDIA
 * NIM fallback) write a structured, cited article using ONLY those passages.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";

const WORDS: Record<string, number> = { short: 700, medium: 1300, long: 2200 };

export type Citation = { n: number; file: string; uri: string };

async function callGemini(key: string, prompt: string, maxTokens: number) {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.7,
				maxOutputTokens: maxTokens,
				// gemini-2.5-flash is a thinking model; reasoning tokens otherwise
				// consume the output budget and truncate long articles. Disable it.
				thinkingConfig: { thinkingBudget: 0 },
			},
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok)
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	const d = await res.json();
	return (
		d?.candidates?.[0]?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? ""
	);
}

async function callNvidia(key: string, prompt: string, maxTokens: number) {
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
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok)
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	const d = await res.json();
	return d?.choices?.[0]?.message?.content ?? "";
}

function buildPrompt(
	topic: string,
	sources: Citation[],
	sourceText: string[],
	words: number,
	tone?: string,
): string {
	const block = sources
		.map((s, i) => `[${s.n}] (${s.file})\n${sourceText[i]}`)
		.join("\n\n");
	return `You are an expert long-form writer creating an article from a corpus of spiritual talks and transcripts.

TOPIC: ${topic}
${tone ? `TONE: ${tone}\n` : ""}TARGET LENGTH: about ${words} words.

Write a comprehensive, well-structured article on the topic, grounded STRICTLY in the numbered SOURCE EXCERPTS below.
Rules:
- Use ONLY information supported by the excerpts — do NOT invent facts, names, quotes, or claims.
- Begin with a compelling title as a Markdown H1 ("# Title"), then use clear section headings ("## ...").
- Where a statement draws on a source, cite it inline as [n] using the source numbers.
- You may weave in short direct quotes from the excerpts (in quotation marks) with their [n].
- Synthesise across sources into engaging, coherent, publishable prose — don't just list them.
- If the excerpts don't cover something, leave it out rather than fabricating.
Return ONLY the article in Markdown, starting with the "# " title. Do NOT append a separate sources list.

SOURCE EXCERPTS:
${block}`;
}

export async function generateArticle(
	topic: string,
	opts: {
		geminiKey?: string;
		nvidiaKey?: string;
		tone?: string;
		length?: "short" | "medium" | "long";
	},
): Promise<{
	title: string;
	content: string;
	citations: Citation[];
	provider: "gemini" | "nvidia";
}> {
	if (!opts.geminiKey && !opts.nvidiaKey) {
		throw new Error(
			"Add a Gemini or NVIDIA API key in Settings → Service keys first.",
		);
	}
	const passages = await searchCorpus(topic, { pageSize: 18 });
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
			.slice(0, 1500),
	);
	const words = WORDS[opts.length ?? "medium"] ?? 1300;
	const maxTokens = Math.min(8192, Math.round(words * 2.2));
	const prompt = buildPrompt(topic, sources, sourceText, words, opts.tone);

	const errors: string[] = [];
	let content = "";
	let provider: "gemini" | "nvidia" = "gemini";
	if (opts.geminiKey) {
		try {
			content = await callGemini(opts.geminiKey, prompt, maxTokens);
			provider = "gemini";
		} catch (e) {
			errors.push(`Gemini: ${e instanceof Error ? e.message : e}`);
		}
	}
	if (!content.trim() && opts.nvidiaKey) {
		try {
			content = await callNvidia(
				opts.nvidiaKey,
				prompt,
				Math.min(maxTokens, 4096),
			);
			provider = "nvidia";
		} catch (e) {
			errors.push(`NVIDIA: ${e instanceof Error ? e.message : e}`);
		}
	}
	content = content.trim().replace(/^```(?:markdown)?\s*|\s*```$/g, "");
	if (!content)
		throw new Error(`Article generation failed. ${errors.join(" | ")}`);

	const titleMatch = content.match(/^#\s+(.+)$/m);
	const title = titleMatch ? titleMatch[1].trim() : topic;
	// Keep only sources actually cited, if any [n] appear; else keep all.
	const cited = new Set(
		[...content.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
	);
	const citations = cited.size
		? sources.filter((s) => cited.has(s.n))
		: sources;
	return { title, content, citations, provider };
}
