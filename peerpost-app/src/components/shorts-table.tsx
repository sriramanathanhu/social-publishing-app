"use client";

import { type Ecosystem, PublishRow, readJson } from "@/components/publish-row";

type ShortsJobRow = {
	id: string;
	status: string;
	sourceInput: string;
	numClips: number;
	error: string | null;
	createdAt: string | Date;
};
type ClipRow = {
	id: string;
	jobId: string;
	idx: number;
	title: string | null;
	description: string | null;
	durationSec: number | null;
	viralScore: number | null;
	publicUrl: string | null;
};

function StatusBadge({ status }: { status: string }) {
	const cls =
		status === "done"
			? "bg-green-100 text-green-700"
			: status === "failed"
				? "bg-red-100 text-red-700"
				: "bg-blue-100 text-blue-700";
	return (
		<span className={`rounded px-1.5 py-0.5 text-xs ${cls}`}>{status}</span>
	);
}

export function ShortsTable({
	jobs,
	clips,
	ecosystems,
}: {
	jobs: ShortsJobRow[];
	clips: ClipRow[];
	ecosystems: Ecosystem[];
}) {
	if (jobs.length === 0) {
		return (
			<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
				No shorts yet. Generate clips above and they’ll appear here to publish.
			</p>
		);
	}

	return (
		<div className="space-y-5">
			<h2 className="text-sm font-semibold opacity-70">Generated clips</h2>
			{jobs.map((job) => {
				const jobClips = clips.filter((c) => c.jobId === job.id);
				return (
					<div key={job.id} className="space-y-3">
						{/* Job header */}
						<div className="flex items-center justify-between gap-3 rounded-lg bg-black/[0.03] px-4 py-2 text-sm">
							<div className="min-w-0">
								<div className="truncate font-medium">{job.sourceInput}</div>
								<div className="text-xs opacity-50">
									{jobClips.length}/{job.numClips} clips ·{" "}
									{new Date(job.createdAt).toLocaleString()}
								</div>
							</div>
							<StatusBadge status={job.status} />
						</div>
						{job.error && (
							<p className="px-4 text-xs text-red-600">{job.error}</p>
						)}

						{jobClips.length > 0 && (
							<>
								<div className="hidden gap-3 px-3 text-xs font-medium uppercase tracking-wide opacity-40 md:grid md:grid-cols-[96px_1fr_1.5fr_220px]">
									<div>Clip</div>
									<div>Title</div>
									<div>Description / Caption</div>
									<div>Publish to</div>
								</div>
								{jobClips.map((c) =>
									c.publicUrl ? (
										<PublishRow
											key={c.id}
											previewUrl={c.publicUrl}
											dubSourceUrl={c.publicUrl ?? undefined}
											meta={[
												`#${c.idx}`,
												c.durationSec ? `${c.durationSec}s` : null,
												c.viralScore ? `score ${c.viralScore}` : null,
											]
												.filter(Boolean)
												.join(" · ")}
											initialTitle={c.title ?? ""}
											initialCaption={c.description ?? ""}
											ecosystems={ecosystems}
											deleteUrl={`/api/shorts/clips/${c.id}`}
											prepareMedia={async () => {
												// Re-host the public R2 clip into PostPeer media.
												const r = await fetch("/api/media/from-url", {
													method: "POST",
													headers: { "Content-Type": "application/json" },
													body: JSON.stringify({ url: c.publicUrl }),
												});
												const d = await readJson(r);
												if (!r.ok)
													throw new Error(d.error ?? "Couldn’t prepare clip");
												return d.publicUrl as string;
											}}
										/>
									) : (
										<div
											key={c.id}
											className="rounded-lg border border-black/10 px-4 py-3 text-sm opacity-60"
										>
											#{c.idx} {c.title} — stored, no public URL yet
										</div>
									),
								)}
							</>
						)}
					</div>
				);
			})}
		</div>
	);
}
