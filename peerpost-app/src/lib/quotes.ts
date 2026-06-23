import "server-only";

/**
 * Quote generation: turn long-form content into several powerful, standalone
 * social-media quotes. Runs on the user's own keys — Gemini first, NVIDIA NIM
 * (Llama) as a fallback — purely text, so it never touches the video sidecar.
 */

export type GeneratedQuote = { text: string; hashtags: string[] };

const GEMINI_MODEL = "gemini-2.5-flash";
const NVIDIA_URL = "https://integrate.api.nvidia.com/v1/chat/completions";
const NVIDIA_MODEL = "meta/llama-3.3-70b-instruct";

function buildPrompt(
	text: string,
	count: number,
	tone?: string,
	avoid?: string[],
	outputLang?: string,
): string {
	const avoidBlock =
		avoid && avoid.length
			? `\nDo NOT repeat or closely paraphrase any of these existing quotes — give genuinely different ones:\n${avoid.map((a) => `- ${a}`).join("\n")}\n`
			: "";
	const langBlock = outputLang
		? `\nWrite EVERY quote AND its hashtags in ${outputLang}. The source content may be in another language — translate the meaning and produce natural, idiomatic ${outputLang}. Do not mix languages or transliterate into Latin script.\n`
		: "";
	return `You are a world-class social-media editor and copywriter.
From the SOURCE CONTENT below, craft ${count} powerful, standalone quotes ready to post on social media.

Each quote MUST:
- Stand completely on its own — make full sense with ZERO prior context.
- Carry ONE profound, provocative, or memorable insight drawn from the source.
- Stay faithful to the source's meaning and voice — distill and sharpen, never fabricate.
- Be tight and high-impact${tone ? ` in a ${tone} tone` : ""}; ideally under 280 characters.
- Contain no surrounding quotation marks, no hashtags inside the text, and no emojis unless essential.

Vary the angle across the set (hook, teaching, reframe, call-to-reflection) so the quotes don't repeat each other.
Give 2-3 relevant lowercase hashtags (without the # symbol) per quote.
${langBlock}${avoidBlock}
Return ONLY JSON — no markdown fences, no commentary — exactly:
{"quotes":[{"text":"the quote","hashtags":["tag","tag"]}]}

SOURCE CONTENT:
${text}`;
}

/** Per-platform writing norms used when tailoring a quote. */
const PLATFORM_GUIDE: Record<string, string> = {
	twitter: "≤280 characters, punchy and scroll-stopping, at most 1-2 hashtags.",
	linkedin:
		"a strong first-line hook then the insight; professional and reflective; up to ~3 short lines; 3 relevant hashtags; optional soft question to invite engagement.",
	facebook: "warm and conversational, medium length, 0-2 hashtags.",
	threads: "casual and conversational, ≤500 characters, 1-2 hashtags.",
	bluesky: "≤300 characters, plain and direct, minimal or no hashtags.",
	reddit: "no hashtags, a discursive reflective tone, may pose a question.",
	telegram: "plain text, no hashtags needed, may be a touch longer.",
	discord: "casual plain text, no hashtags.",
	whatsapp: "plain text, warm, no hashtags.",
	googlebusiness: "concise and professional, 0-1 hashtag.",
};

function parseQuotes(raw: string, count: number): GeneratedQuote[] {
	const cleaned = raw
		.trim()
		.replace(/^```json\s*|^```\s*|\s*```$/gm, "")
		.trim();
	let data: unknown;
	try {
		data = JSON.parse(cleaned);
	} catch {
		const m = cleaned.match(/\{[\s\S]*"quotes"[\s\S]*\}/);
		if (!m) throw new Error("the model returned no parseable quotes");
		data = JSON.parse(m[0]);
	}
	const arr = Array.isArray((data as { quotes?: unknown })?.quotes)
		? (data as { quotes: unknown[] }).quotes
		: Array.isArray(data)
			? (data as unknown[])
			: [];
	return arr
		.map((q): GeneratedQuote => {
			const obj = q as { text?: unknown; hashtags?: unknown };
			const text = String((typeof q === "string" ? q : obj?.text) ?? "").trim();
			const hashtags = Array.isArray(obj?.hashtags)
				? obj.hashtags
						.map((h) => String(h).replace(/^#/, "").trim())
						.filter(Boolean)
						.slice(0, 3)
				: [];
			return { text, hashtags };
		})
		.filter((q) => q.text.length > 0)
		.slice(0, count);
}

/** Low-level call to Gemini's REST API; returns the raw text part. */
async function callGemini(key: string, prompt: string): Promise<string> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				responseMimeType: "application/json",
				temperature: 0.9,
			},
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) {
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	}
	const d = await res.json();
	return (
		d?.candidates?.[0]?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? ""
	);
}

/** Low-level call to NVIDIA NIM's OpenAI-compatible chat API. */
async function callNvidia(key: string, prompt: string): Promise<string> {
	const res = await fetch(NVIDIA_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: NVIDIA_MODEL,
			messages: [{ role: "user", content: prompt }],
			temperature: 0.9,
			max_tokens: 2048,
		}),
		signal: AbortSignal.timeout(90_000),
	});
	if (!res.ok) {
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	}
	const d = await res.json();
	return d?.choices?.[0]?.message?.content ?? "";
}

type Keys = { geminiKey?: string; nvidiaKey?: string };

/** Run a prompt through Gemini → NVIDIA fallback, returning the raw output and
 * which provider answered. Throws with both errors if neither works. */
async function withFallback(
	keys: Keys,
	prompt: string,
): Promise<{ out: string; provider: "gemini" | "nvidia" }> {
	if (!keys.geminiKey && !keys.nvidiaKey) {
		throw new Error(
			"Add a Gemini or NVIDIA API key in Settings → Service keys first.",
		);
	}
	const errors: string[] = [];
	if (keys.geminiKey) {
		try {
			const out = await callGemini(keys.geminiKey, prompt);
			if (out.trim()) return { out, provider: "gemini" };
			errors.push("Gemini: empty result");
		} catch (e) {
			errors.push(`Gemini: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (keys.nvidiaKey) {
		try {
			const out = await callNvidia(keys.nvidiaKey, prompt);
			if (out.trim()) return { out, provider: "nvidia" };
			errors.push("NVIDIA: empty result");
		} catch (e) {
			errors.push(`NVIDIA: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(errors.join(" | "));
}

export async function generateQuotes(
	text: string,
	opts: Keys & {
		count?: number;
		tone?: string;
		avoid?: string[];
		outputLang?: string;
	},
): Promise<{ quotes: GeneratedQuote[]; provider: "gemini" | "nvidia" }> {
	const { count = 6, tone, avoid, outputLang } = opts;
	try {
		const { out, provider } = await withFallback(
			opts,
			buildPrompt(text, count, tone, avoid, outputLang),
		);
		const quotes = parseQuotes(out, count);
		if (!quotes.length) throw new Error("the model returned no quotes");
		return { quotes, provider };
	} catch (e) {
		throw new Error(
			`Quote generation failed. ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/**
 * Rewrite one quote for each target platform, honouring that platform's norms
 * (length, tone, hashtags) — not just truncating. Returns platform → text for
 * the platforms it could adapt; callers fall back to the original elsewhere.
 */
export async function tailorQuote(
	quote: string,
	platforms: string[],
	opts: Keys & { tone?: string },
): Promise<{
	variants: Record<string, string>;
	provider: "gemini" | "nvidia";
}> {
	const wanted = [...new Set(platforms)].filter((p) => p);
	if (wanted.length === 0) return { variants: {}, provider: "gemini" };
	const guides = wanted
		.map(
			(p) =>
				`- ${p}: ${PLATFORM_GUIDE[p] ?? "concise and platform-appropriate."}`,
		)
		.join("\n");
	const prompt = `Adapt this social-media quote for each target platform below, preserving its core meaning and impact${opts.tone ? ` and a ${opts.tone} tone` : ""}. REWRITE for each platform's norms — don't merely truncate. Keep hashtags appropriate to each platform.

QUOTE:
${quote}

PLATFORMS:
${guides}

Return ONLY JSON mapping each platform key to its adapted text — no markdown fences, no commentary:
{${wanted.map((p) => `"${p}":"..."`).join(",")}}`;

	const { out, provider } = await withFallback(opts, prompt).catch((e) => {
		throw new Error(`Tailoring failed. ${e instanceof Error ? e.message : e}`);
	});
	const cleaned = out
		.trim()
		.replace(/^```json\s*|^```\s*|\s*```$/gm, "")
		.trim();
	let data: Record<string, unknown>;
	try {
		data = JSON.parse(cleaned);
	} catch {
		const m = /\{[\s\S]*\}/.exec(cleaned);
		if (!m) throw new Error("Tailoring returned no parseable result.");
		data = JSON.parse(m[0]);
	}
	const variants: Record<string, string> = {};
	for (const p of wanted) {
		const v = data[p];
		if (typeof v === "string" && v.trim()) variants[p] = v.trim();
	}
	return { variants, provider };
}
