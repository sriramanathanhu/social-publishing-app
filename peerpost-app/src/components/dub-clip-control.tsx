"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { DUB_LANGUAGES } from "@/lib/dub-options";

/**
 * "Dub to other languages" for a generated clip. Starts one dub job per selected
 * language using the clip's public URL as the source (sourceType "upload" → the
 * sidecar fetches it directly). Results land in the Dub page / Archive.
 */
export function DubClipControl({ sourceUrl }: { sourceUrl: string }) {
	const router = useRouter();
	const [open, setOpen] = useState(false);
	const [langs, setLangs] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	function toggle(code: string) {
		setLangs((prev) => {
			const next = new Set(prev);
			next.has(code) ? next.delete(code) : next.add(code);
			return next;
		});
	}

	async function start() {
		if (langs.size === 0) {
			setMsg("Pick at least one language.");
			return;
		}
		setBusy(true);
		setMsg(null);
		let started = 0;
		let failed = 0;
		let lastErr = "";
		for (const code of langs) {
			const lang = DUB_LANGUAGES.find((l) => l.code === code);
			const voice = lang?.voices[0]?.id;
			try {
				const r = await fetch("/api/dub", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						sourceType: "upload",
						sourceInput: sourceUrl,
						sourceLang: "auto",
						targetLang: code,
						voice,
					}),
				});
				if (r.ok) started++;
				else {
					failed++;
					const d = await r.json().catch(() => ({}));
					lastErr = d.error ?? "";
				}
			} catch {
				failed++;
			}
		}
		setBusy(false);
		setMsg(
			started
				? `Started ${started} dub${started === 1 ? "" : "s"}${failed ? `, ${failed} failed` : ""} — track them on the Dub page.`
				: `Couldn’t start${lastErr ? `: ${lastErr}` : "."}`,
		);
		if (started) {
			setLangs(new Set());
			router.refresh();
		}
	}

	if (!open) {
		return (
			<button
				type="button"
				onClick={() => setOpen(true)}
				className="text-xs font-medium text-primary hover:underline"
			>
				Dub to other languages →
			</button>
		);
	}

	return (
		<div className="space-y-2">
			<div className="text-xs font-medium opacity-60">Dub this clip into:</div>
			<div className="flex flex-wrap gap-1.5">
				{DUB_LANGUAGES.map((l) => (
					<button
						type="button"
						key={l.code}
						onClick={() => toggle(l.code)}
						className={`rounded-full border px-2.5 py-1 text-xs ${
							langs.has(l.code)
								? "border-primary bg-primary text-white"
								: "border-black/15 hover:bg-black/5"
						}`}
					>
						{l.label}
					</button>
				))}
			</div>
			<div className="flex flex-wrap items-center gap-3">
				<button
					type="button"
					onClick={start}
					disabled={busy}
					className="h-8 rounded-md bg-primary px-3 text-xs font-medium text-white disabled:opacity-50"
				>
					{busy ? "Starting…" : `Dub to ${langs.size || 0} language(s)`}
				</button>
				<button
					type="button"
					onClick={() => setOpen(false)}
					className="text-xs opacity-50 hover:opacity-100"
				>
					Cancel
				</button>
				{msg && <span className="text-xs opacity-70">{msg}</span>}
			</div>
			<p className="text-[11px] opacity-40">
				Needs your Deepgram + Gemini keys. Note: burned-in captions stay in the
				original language; the voiceover is translated.
			</p>
		</div>
	);
}
