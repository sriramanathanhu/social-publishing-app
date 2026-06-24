import "server-only";

/**
 * Translate arbitrary (possibly long) text into a target language via Gemini.
 * The text is split into paragraph-aligned chunks so each stays well within the
 * model's output limit, then translated and re-joined.
 */

const MODEL = "gemini-2.5-flash";
const MAX_CHARS = 9000;

function chunk(text: string): string[] {
	const paras = text.split(/\n{2,}/);
	const chunks: string[] = [];
	let cur = "";
	for (const p of paras) {
		if (cur && cur.length + p.length + 2 > MAX_CHARS) {
			chunks.push(cur);
			cur = "";
		}
		// A single paragraph longer than the limit: hard-split it.
		if (p.length > MAX_CHARS) {
			for (let i = 0; i < p.length; i += MAX_CHARS) {
				chunks.push(p.slice(i, i + MAX_CHARS));
			}
			continue;
		}
		cur = cur ? `${cur}\n\n${p}` : p;
	}
	if (cur) chunks.push(cur);
	return chunks.length ? chunks : [text];
}

async function translateChunk(
	text: string,
	lang: string,
	key: string,
): Promise<string> {
	const prompt = `Translate the text below into ${lang}. Output ONLY the ${lang} translation — faithful and natural, preserving the paragraph breaks. Do NOT add notes, headers, or commentary, and do not transliterate into Latin script.\n\nTEXT:\n${text}`;
	const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${encodeURIComponent(key)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			contents: [{ parts: [{ text: prompt }] }],
			generationConfig: {
				temperature: 0.2,
				maxOutputTokens: 8192,
				thinkingConfig: { thinkingBudget: 0 },
			},
		}),
		signal: AbortSignal.timeout(120_000),
	});
	if (!res.ok) {
		throw new Error(
			`Gemini ${res.status}: ${(await res.text()).slice(0, 160)}`,
		);
	}
	const d = await res.json();
	return (
		d?.candidates?.[0]?.content?.parts
			?.map((p: { text?: string }) => p.text ?? "")
			.join("") ?? ""
	);
}

export async function translateText(
	text: string,
	targetLang: string,
	geminiKey: string,
): Promise<string> {
	const chunks = chunk(text.trim());
	const out: string[] = [];
	for (const c of chunks) {
		out.push((await translateChunk(c, targetLang, geminiKey)).trim());
	}
	const joined = out.filter(Boolean).join("\n\n").trim();
	if (!joined) throw new Error("Translation returned no text.");
	return joined;
}
