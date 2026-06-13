import type { PostPlatformTarget } from "@/db/schema";

/** Compact, low-noise representation of a post (shared by overview/scheduled). */
export function PostRow({
	content,
	platforms,
	profileName,
	when,
	status,
	action,
	metrics,
}: {
	content: string | null;
	platforms: PostPlatformTarget[] | null;
	profileName: string;
	when: string;
	status: string;
	action?: React.ReactNode;
	metrics?: { likes: number | null; views: number | null } | null;
}) {
	const statusColor =
		status === "published"
			? "bg-green-100 text-green-700"
			: status === "scheduled"
				? "bg-blue-100 text-blue-700"
				: status === "failed"
					? "bg-red-100 text-red-700"
					: "bg-black/5 text-black/60";

	return (
		<li className="flex items-center gap-3 rounded-lg border border-black/10 px-4 py-3">
			<div className="min-w-0 flex-1">
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium opacity-60">{profileName}</span>
					<span className="flex gap-1">
						{(platforms ?? []).map((p) => (
							<span
								key={p.accountId}
								className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] uppercase"
							>
								{p.platform}
							</span>
						))}
					</span>
				</div>
				<p className="truncate text-sm">{content ?? "—"}</p>
			</div>
			{metrics && (metrics.likes != null || metrics.views != null) && (
				<span className="shrink-0 text-xs opacity-50">
					{metrics.likes != null ? `♥ ${metrics.likes.toLocaleString()}` : ""}
					{metrics.views != null ? `  ▶ ${metrics.views.toLocaleString()}` : ""}
				</span>
			)}
			<span className="shrink-0 text-xs opacity-50">{when}</span>
			<span
				className={`shrink-0 rounded-full px-2 py-0.5 text-xs ${statusColor}`}
			>
				{status}
			</span>
			{action}
		</li>
	);
}

/** Short local datetime, e.g. "Jun 13, 14:30". */
export function shortDate(d: Date | string | null): string {
	if (!d) return "—";
	const date = typeof d === "string" ? new Date(d) : d;
	return date.toLocaleString(undefined, {
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
