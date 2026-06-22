"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Presence = {
	deepgram: boolean;
	gemini: boolean;
	nvidia: boolean;
};

const FIELDS: {
	name: keyof Presence;
	label: string;
	help: string;
	required: boolean;
}[] = [
	{
		name: "deepgram",
		label: "Deepgram API key",
		help: "Transcription (speech → timed text). Required for Dub + Shorts.",
		required: true,
	},
	{
		name: "gemini",
		label: "Gemini API key",
		help: "Translation and vision (Dub). Required for dubbing.",
		required: true,
	},
	{
		name: "nvidia",
		label: "NVIDIA API key",
		help: "Shorts clip-finding + titles, and Dub AI captions (NVIDIA NIM). Required for Shorts.",
		required: false,
	},
];

/** Save/update the current user's dubbing API keys. Values are write-only. */
export function ApiKeysForm({ presence }: { presence: Presence }) {
	const router = useRouter();
	const [values, setValues] = useState<Record<string, string>>({});
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState(false);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		setSaved(false);
		try {
			// Only send fields the user actually typed into.
			const body = Object.fromEntries(
				Object.entries(values).filter(([, v]) => v.length > 0),
			);
			const res = await fetch("/api/keys", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.error ?? "Failed to save keys");
			}
			setValues({});
			setSaved(true);
			router.refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			onSubmit={submit}
			className="space-y-4 rounded-lg border border-black/10 p-4"
		>
			{FIELDS.map((f) => (
				<div key={f.name}>
					<label className="mb-1 flex items-center gap-2 text-sm font-medium">
						{f.label}
						{presence[f.name] ? (
							<span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
								set
							</span>
						) : (
							f.required && (
								<span className="rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
									not set
								</span>
							)
						)}
					</label>
					<input
						type="password"
						autoComplete="off"
						value={values[f.name] ?? ""}
						onChange={(e) =>
							setValues((v) => ({ ...v, [f.name]: e.target.value }))
						}
						placeholder={
							presence[f.name] ? "•••• (leave blank to keep)" : "Paste key"
						}
						className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
					/>
					<p className="mt-1 text-xs opacity-50">{f.help}</p>
				</div>
			))}

			<div className="flex items-center gap-3">
				<button
					type="submit"
					disabled={busy}
					className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? "Saving…" : "Save keys"}
				</button>
				{saved && <span className="text-sm text-green-600">Saved.</span>}
				{error && <span className="text-sm text-red-600">{error}</span>}
			</div>
		</form>
	);
}
