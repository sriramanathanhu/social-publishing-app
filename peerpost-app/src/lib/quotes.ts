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

function buildPrompt(text: string, count: number, tone?: string): string {
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

Return ONLY JSON — no markdown fences, no commentary — exactly:
{"quotes":[{"text":"the quote","hashtags":["tag","tag"]}]}

SOURCE CONTENT:
${text}`;
}

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

async function viaGemini(
	key: string,
	text: string,
	count: number,
	tone?: string,
): Promise<GeneratedQuote[]> {
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: buildPrompt(text, count, tone) }] }],
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
	const out =
		d?.candidates?.[0]?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? "";
	return parseQuotes(out, count);
}

async function viaNvidia(
	key: string,
	text: string,
	count: number,
	tone?: string,
): Promise<GeneratedQuote[]> {
	const res = await fetch(NVIDIA_URL, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${key}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: NVIDIA_MODEL,
			messages: [{ role: "user", content: buildPrompt(text, count, tone) }],
			temperature: 0.9,
			max_tokens: 2048,
		}),
		signal: AbortSignal.timeout(90_000),
	});
	if (!res.ok) {
		throw new Error(`${res.status} ${(await res.text()).slice(0, 160)}`);
	}
	const d = await res.json();
	const out = d?.choices?.[0]?.message?.content ?? "";
	return parseQuotes(out, count);
}

export async function generateQuotes(
	text: string,
	opts: {
		geminiKey?: string;
		nvidiaKey?: string;
		count?: number;
		tone?: string;
	},
): Promise<{ quotes: GeneratedQuote[]; provider: "gemini" | "nvidia" }> {
	const { geminiKey, nvidiaKey, count = 6, tone } = opts;
	if (!geminiKey && !nvidiaKey) {
		throw new Error(
			"Add a Gemini or NVIDIA API key in Settings → Service keys first.",
		);
	}
	const errors: string[] = [];
	if (geminiKey) {
		try {
			const quotes = await viaGemini(geminiKey, text, count, tone);
			if (quotes.length) return { quotes, provider: "gemini" };
			errors.push("Gemini: empty result");
		} catch (e) {
			errors.push(`Gemini: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (nvidiaKey) {
		try {
			const quotes = await viaNvidia(nvidiaKey, text, count, tone);
			if (quotes.length) return { quotes, provider: "nvidia" };
			errors.push("NVIDIA: empty result");
		} catch (e) {
			errors.push(`NVIDIA: ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	throw new Error(`Quote generation failed. ${errors.join(" | ")}`);
}
