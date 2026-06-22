"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Item = { id: string; url: string; label: string | null };

/** Admin: upload + manage a media library section (backgrounds or overlays). */
export function GalleryManager({
	title,
	hint,
	items,
	uploadUrl,
	deleteBase,
	accept,
	checkered,
}: {
	readonly title: string;
	readonly hint: string;
	readonly items: Item[];
	readonly uploadUrl: string;
	readonly deleteBase: string;
	readonly accept: string;
	readonly checkered?: boolean;
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
			const res = await fetch(uploadUrl, { method: "POST", body: fd });
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
		if (!window.confirm(`Delete this ${title.toLowerCase()}?`)) return;
		const res = await fetch(`${deleteBase}/${id}`, { method: "DELETE" });
		if (res.ok) router.refresh();
		else window.alert("Delete failed");
	}

	return (
		<section className="space-y-3">
			<div className="flex flex-wrap items-center gap-3">
				<h2 className="text-sm font-semibold">{title}</h2>
				<input
					value={label}
					onChange={(e) => setLabel(e.target.value)}
					placeholder="Label (optional)"
					className="rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
				/>
				<label className="cursor-pointer rounded-md bg-primary px-4 py-2 text-sm font-medium text-white">
					{busy ? "Uploading…" : "Upload"}
					<input
						type="file"
						accept={accept}
						className="hidden"
						disabled={busy}
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) upload(f);
						}}
					/>
				</label>
				<span className="text-xs opacity-50">{hint}</span>
				{error && <span className="text-sm text-red-600">{error}</span>}
			</div>

			{items.length === 0 ? (
				<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
					Nothing here yet.
				</p>
			) : (
				<div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
					{items.map((it) => (
						<div key={it.id} className="group relative">
							{/* biome-ignore lint/performance/noImgElement: small admin thumbnail */}
							<img
								src={it.url}
								alt={it.label ?? title}
								className={`aspect-[4/5] w-full rounded-lg border border-black/10 object-cover ${checkered ? "bg-[length:16px_16px] bg-[linear-gradient(45deg,#ddd_25%,transparent_25%),linear-gradient(-45deg,#ddd_25%,transparent_25%),linear-gradient(45deg,transparent_75%,#ddd_75%),linear-gradient(-45deg,transparent_75%,#ddd_75%)] [background-position:0_0,0_8px,8px_-8px,-8px_0]" : ""}`}
							/>
							<button
								type="button"
								onClick={() => remove(it.id)}
								className="absolute right-1 top-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white opacity-0 transition group-hover:opacity-100"
							>
								Delete
							</button>
							{it.label && (
								<div className="mt-1 truncate text-[11px] opacity-60">
									{it.label}
								</div>
							)}
						</div>
					))}
				</div>
			)}
		</section>
	);
}
