"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { type Ecosystem, PublishRow, readJson } from "@/components/publish-row";

/** Delete a whole shorts job (and its clips). Owner/admin enforced server-side. */
function DeleteJobButton({ id }: { id: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	async function remove() {
		if (!window.confirm("Delete this shorts job and all its clips?")) return;
		setBusy(true);
		try {
			const r = await fetch(`/api/shorts/${id}`, { method: "DELETE" });
			const d = await readJson(r);
			if (!r.ok) throw new Error(d.error ?? "Delete failed");
			router.refresh();
		} catch (err) {
			setBusy(false);
			window.alert(err instanceof Error ? err.message : "Delete failed");
		}
	}
	return (
		<button
			type="button"
			onClick={remove}
			disabled={busy}
			className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
		>
			{busy ? "Deleting…" : "Delete"}
		</button>
	);
}

type ShortsJobRow = {
	id: string;
	name: string | null;
	status: string;
	sourceInput: string;
	numClips: number;
	error: string | null;
	createdAt: string | Date;
	completedAt: string | Date | null;
};

/** Human-readable elapsed time between two timestamps (e.g. "3m 12s"). */
function timeTaken(
	start: string | Date,
	end: string | Date | null,
): string | null {
	if (!end) return null;
	const ms = new Date(end).getTime() - new Date(start).getTime();
	if (!Number.isFinite(ms) || ms < 0) return null;
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${s % 60}s`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}
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
								<a
									href={job.sourceInput}
									target="_blank"
									rel="noreferrer"
									className="block truncate font-medium text-primary hover:underline"
									title={job.sourceInput}
								>
									{job.name || job.sourceInput}
								</a>
								<div className="text-xs opacity-50">
									{jobClips.length}/{job.numClips} clips ·{" "}
									{new Date(job.createdAt).toLocaleString()}
									{timeTaken(job.createdAt, job.completedAt)
										? ` · took ${timeTaken(job.createdAt, job.completedAt)}`
										: ""}
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-2">
								<StatusBadge status={job.status} />
								<DeleteJobButton id={job.id} />
							</div>
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
											source="short"
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
