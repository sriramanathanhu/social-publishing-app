"use client";

import { useRef, useState } from "react";

type Clip = {
	id: string;
	title: string | null;
	url: string | null;
	durationSec: number | null;
	viralScore: number | null;
};
type Upload = {
	id: string;
	title: string;
	url: string;
	createdAt: string | Date;
};

function VideoCard({
	url,
	title,
	subtitle,
	onDelete,
}: {
	url: string;
	title: string;
	subtitle?: string;
	onDelete?: () => void;
}) {
	return (
		<div className="group relative">
			{/* biome-ignore lint/a11y/useMediaCaption: user media preview */}
			<video
				src={url}
				controls
				preload="metadata"
				className="aspect-[9/16] w-full rounded-lg border border-slate-200 bg-black object-cover"
			/>
			<div className="mt-1 truncate text-slate-700 text-xs" title={title}>
				{title}
			</div>
			{subtitle && <div className="text-[11px] text-slate-400">{subtitle}</div>}
			{onDelete && (
				<button
					type="button"
					onClick={onDelete}
					className="absolute top-1 right-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] text-white opacity-0 transition group-hover:opacity-100"
				>
					Delete
				</button>
			)}
		</div>
	);
}

export function VideoLibrary({
	clips,
	initialUploads,
}: {
	clips: Clip[];
	initialUploads: Upload[];
}) {
	const [uploads, setUploads] = useState<Upload[]>(initialUploads);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	async function upload(file: File) {
		setBusy(true);
		setError(null);
		try {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch("/api/video", { method: "POST", body: fd });
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Upload failed");
			setUploads((prev) => [d.video, ...prev]);
		} catch (e) {
			setError(e instanceof Error ? e.message : "Upload failed");
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: string) {
		setUploads((prev) => prev.filter((v) => v.id !== id));
		await fetch(`/api/video/${id}`, { method: "DELETE" }).catch(() => {});
	}

	return (
		<div className="space-y-8">
			<section className="space-y-3">
				<div className="flex flex-wrap items-center gap-3">
					<h2 className="font-semibold text-slate-800 text-sm">
						Uploaded videos
					</h2>
					<button
						type="button"
						onClick={() => fileRef.current?.click()}
						disabled={busy}
						className="rounded-lg bg-slate-900 px-3 py-1.5 font-medium text-sm text-white disabled:opacity-50"
					>
						{busy ? "Uploading…" : "Upload video"}
					</button>
					<span className="text-slate-400 text-xs">
						MP4/MOV/WebM · for manually-edited shorts · max 500MB
					</span>
					{error && <span className="text-red-600 text-sm">{error}</span>}
					<input
						ref={fileRef}
						type="file"
						accept="video/*"
						className="hidden"
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) upload(f);
							e.target.value = "";
						}}
					/>
				</div>
				{uploads.length === 0 ? (
					<p className="text-slate-400 text-sm">No uploaded videos yet.</p>
				) : (
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
						{uploads.map((v) => (
							<VideoCard
								key={v.id}
								url={v.url}
								title={v.title}
								onDelete={() => remove(v.id)}
							/>
						))}
					</div>
				)}
			</section>

			<section className="space-y-3">
				<h2 className="font-semibold text-slate-800 text-sm">
					Generated shorts
				</h2>
				{clips.length === 0 ? (
					<p className="text-slate-400 text-sm">
						No generated shorts yet — create some under Content › Shorts.
					</p>
				) : (
					<div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
						{clips.map((c) => (
							<VideoCard
								key={c.id}
								url={c.url ?? ""}
								title={c.title ?? "Clip"}
								subtitle={[
									c.durationSec ? `${c.durationSec}s` : null,
									c.viralScore ? `★ ${c.viralScore}` : null,
								]
									.filter(Boolean)
									.join(" · ")}
							/>
						))}
					</div>
				)}
			</section>
		</div>
	);
}
