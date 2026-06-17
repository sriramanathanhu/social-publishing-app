"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Assets = {
	overlay: string | null;
	transition: string | null;
	endcard: string | null;
};
type Kind = keyof Assets;

const ROWS: { kind: Kind; label: string; accept: string; help: string }[] = [
	{
		kind: "overlay",
		label: "Overlay (PNG)",
		accept: "image/png,image/*",
		help: "Full-frame transparent PNG drawn over every clip (frame / watermark).",
	},
	{
		kind: "transition",
		label: "Transition (video)",
		accept: "video/*",
		help: "Short clip inserted between the short and the end card.",
	},
	{
		kind: "endcard",
		label: "End card (video)",
		accept: "video/*",
		help: "Clip appended to the end of every short (outro / subscribe).",
	},
];

/** Upload reusable Shorts render assets (overlay, transition, end-card). */
export function ShortsAssets({ assets }: { assets: Assets }) {
	const router = useRouter();
	const [busy, setBusy] = useState<Kind | null>(null);
	const [error, setError] = useState<string | null>(null);

	async function upload(kind: Kind, file: File) {
		setBusy(kind);
		setError(null);
		try {
			const fd = new FormData();
			fd.append("file", file);
			const up = await fetch("/api/media/upload", { method: "POST", body: fd });
			const upd = await up.json();
			if (!up.ok) throw new Error(upd.error ?? "Upload failed");
			const res = await fetch("/api/shorts/assets", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind, url: upd.publicUrl }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.error ?? "Save failed");
			}
			router.refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(null);
		}
	}

	async function clear(kind: Kind) {
		setBusy(kind);
		setError(null);
		try {
			await fetch("/api/shorts/assets", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind, url: "" }),
			});
			router.refresh();
		} finally {
			setBusy(null);
		}
	}

	return (
		<details className="rounded-lg border border-black/10 p-4">
			<summary className="cursor-pointer text-sm font-medium">
				Render assets (overlay · transition · end card)
			</summary>
			<p className="mt-1 text-xs opacity-50">
				Optional. Applied to every clip in future jobs. Leave empty to skip.
			</p>
			<div className="mt-3 space-y-3">
				{ROWS.map((r) => {
					const current = assets[r.kind];
					return (
						<div key={r.kind} className="text-sm">
							<div className="flex items-center gap-2">
								<span className="font-medium">{r.label}</span>
								{current ? (
									<span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
										set
									</span>
								) : (
									<span className="rounded bg-black/10 px-1.5 py-0.5 text-xs opacity-60">
										not set
									</span>
								)}
							</div>
							<p className="mb-1 text-xs opacity-50">{r.help}</p>
							<div className="flex items-center gap-3">
								<input
									type="file"
									accept={r.accept}
									disabled={busy === r.kind}
									onChange={(e) => {
										const f = e.target.files?.[0];
										if (f) upload(r.kind, f);
									}}
									className="text-xs"
								/>
								{busy === r.kind && (
									<span className="text-xs opacity-60">Uploading…</span>
								)}
								{current && (
									<button
										type="button"
										onClick={() => clear(r.kind)}
										className="text-xs underline opacity-60 hover:opacity-100"
									>
										Clear
									</button>
								)}
							</div>
						</div>
					);
				})}
				{error && <p className="text-sm text-red-600">{error}</p>}
			</div>
		</details>
	);
}
