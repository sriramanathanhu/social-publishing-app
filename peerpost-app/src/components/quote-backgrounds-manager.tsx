"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Background = { id: string; url: string; label: string | null };

/** Admin: upload + manage the curated quote-card background library. */
export function QuoteBackgroundsManager({
	initial,
}: {
	readonly initial: Background[];
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [label, setLabel] = useState("");
	const [error, setError] = useState<string | null>(null);

	async function upload(file: File) {
		setBusy(true);
		setError(null);
		try {
			const fd = new FormData();
			fd.append("file", file);
			if (label.trim()) fd.append("label", label.trim());
			const res = await fetch("/api/quotes/backgrounds", {
				method: "POST",
				body: fd,
			});
			const d = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(d.error ?? "Upload failed");
			setLabel("");
			router.refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: string) {
		if (!window.confirm("Delete this background?")) return;
		const res = await fetch(`/api/quotes/backgrounds/${id}`, {
			method: "DELETE",
		});
		if (res.ok) router.refresh();
		else window.alert("Delete failed");
	}

	return (
		<div className="space-y-4">
			<div className="flex flex-wrap items-center gap-3 rounded-lg border border-black/10 bg-white p-4 shadow-sm">
				<input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Label (optional)"
					className="rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
				/>
				<label className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">
					{busy ? "Uploading…" : "Upload background"}
					<input
						type="file"
						accept="image/jpeg,image/png,image/webp"
						className="hidden"
						disabled={busy}
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) upload(f);
						}}
					/>
				</label>
				<span className="text-xs opacity-50">
					JPEG/PNG/WebP · ideally portrait (1080×1350)
				</span>
				{error && <span className="text-sm text-red-600">{error}</span>}
			</div>

			{initial.length === 0 ? (
				<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
					No backgrounds yet. Upload some for users to pick from.
				</p>
			) : (
				<div className="grid grid-cols-3 gap-3 sm:grid-cols-5">
					{initial.map((b) => (
						<div key={b.id} className="group relative">
							{/* biome-ignore lint/performance/noImgElement: small admin thumbnail */}
							<img
								src={b.url}
								alt={b.label ?? "background"}
								className="aspect-[4/5] w-full rounded-lg border border-black/10 object-cover"
							/>
							<button
								type="button"
								onClick={() => remove(b.id)}
								className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white opacity-0 transition group-hover:opacity-100"
							>
								Delete
							</button>
							{b.label && (
								<div className="mt-1 truncate text-[11px] opacity-60">
									{b.label}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
