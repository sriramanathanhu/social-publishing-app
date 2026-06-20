"use client";

import { type Ecosystem, PublishRow } from "@/components/publish-row";

type DubRowData = {
	id: string;
	status: string;
	targetLang: string;
	createdAt: string;
	videoUrl: string | null;
	title: string;
	caption: string;
};

export function DubTable({
	rows,
	ecosystems,
}: {
	rows: DubRowData[];
	ecosystems: Ecosystem[];
}) {
	if (rows.length === 0) {
		return (
			<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
				No dubs yet. Run a dub above and it will appear here to publish.
			</p>
		);
	}
	return (
		<div className="space-y-3">
			<h2 className="text-sm font-semibold opacity-70">Dubbed videos</h2>
			<div className="hidden gap-3 px-3 text-xs font-medium uppercase tracking-wide opacity-40 md:grid md:grid-cols-[96px_1fr_1.5fr_220px]">
				<div>Video</div>
				<div>Title</div>
				<div>Description / Caption</div>
				<div>Publish to</div>
			</div>
			{rows.map((r) =>
				r.status === "done" ? (
					<PublishRow
						key={r.id}
						previewUrl={r.videoUrl}
						meta={r.targetLang.toUpperCase()}
						initialTitle={r.title}
						initialCaption={r.caption}
						ecosystems={ecosystems}
						prepareMedia={async () => {
							// Host the dub where providers can fetch it (idempotent).
							const ex = await fetch(`/api/dub/${r.id}/export`, {
								method: "POST",
							});
							const d = await ex.json();
							if (!ex.ok)
								throw new Error(d.error ?? "Couldn’t prepare the video");
							return d.publicUrl as string;
						}}
					/>
				) : (
					<div
						key={r.id}
						className="flex items-center justify-between gap-4 rounded-lg border border-black/10 px-4 py-3 text-sm"
					>
						<span className="opacity-60">
							{r.targetLang.toUpperCase()} ·{" "}
							{new Date(r.createdAt).toLocaleString()}
						</span>
						<span
							className={`rounded px-1.5 py-0.5 text-xs ${
								r.status === "failed"
									? "bg-red-100 text-red-700"
									: "bg-blue-100 text-blue-700"
							}`}
						>
							{r.status}
						</span>
					</div>
				),
			)}
		</div>
	);
}
