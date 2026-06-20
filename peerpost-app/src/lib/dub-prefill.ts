import type { DubCaption } from "@/db/schema";
import { DUB_LANGUAGES } from "@/lib/dub-options";

const CAPTION_PREFERENCE = ["instagram", "facebook", "youtube", "threads"];

/** Pick a representative title + caption from the per-platform AI captions. */
export function dubPrefill(
	captions: Record<string, DubCaption> | null | undefined,
): { title: string; caption: string } {
	if (!captions) return { title: "", caption: "" };
	const all = Object.values(captions);
	let caption = "";
	for (const p of CAPTION_PREFERENCE) {
		const c = captions[p]?.caption?.trim();
		if (c) {
			caption = c;
			break;
		}
	}
	if (!caption) caption = all.find((c) => c?.caption?.trim())?.caption ?? "";
	const title =
		all.find((c) => c?.title?.trim())?.title ??
		caption.split(/\s+/).slice(0, 8).join(" ");
	return { title, caption };
}

const EXTRA_LANG: Record<string, string> = { en: "English", auto: "Auto" };

/** Human label for a language code (dub targets + common source langs). */
export function languageLabel(code: string | null | undefined): string {
	if (!code) return "—";
	const fromDub = DUB_LANGUAGES.find((l) => l.code === code)?.label;
	return fromDub ?? EXTRA_LANG[code] ?? code.toUpperCase();
}
