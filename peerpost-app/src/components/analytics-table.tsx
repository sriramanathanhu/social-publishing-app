"use client";

import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import type { AnalyticsMetrics } from "@/db/schema";

type Row = {
	postpeerPostId: string;
	profileId: string;
	profileName: string;
	content: string | null;
	publishedAt: string | Date | null;
	aggregated: AnalyticsMetrics | null;
	platforms: { platform: string; platformPostUrl: string | null; metrics: AnalyticsMetrics }[] | null;
};

const COLS: { key: keyof AnalyticsMetrics; label: string }[] = [
	{ key: "impressions", label: "Impr." },
	{ key: "likes", label: "Likes" },
	{ key: "comments", label: "Comments" },
	{ key: "shares", label: "Shares" },
	{ key: "views", label: "Views" },
	{ key: "engagementRate", label: "Engage." },
];

function fmt(key: keyof AnalyticsMetrics, v: number | null | undefined) {
	if (v == null) return "—";
	if (key === "engagementRate") return `${(v * 100).toFixed(1)}%`;
	return v.toLocaleString();
}

function shortDate(d: string | Date | null) {
	if (!d) return "—";
	return new Date(d).toLocaleDateString(undefined, {
		month: "short",
		day: "numeric",
		year: "numeric",
	});
}

export function AnalyticsTable({
	rows,
	ecosystems,
	lastFetched,
}: {
	rows: Row[];
	ecosystems: { id: string; name: string }[];
	lastFetched: string | Date | null;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [filter, setFilter] = useState<string>("all");
	const [sortKey, setSortKey] = useState<keyof AnalyticsMetrics | "publishedAt">("publishedAt");
	const [expanded, setExpanded] = useState<string | null>(null);

	const view = useMemo(() => {
		let r = filter === "all" ? rows : rows.filter((x) => x.profileId === filter);
		r = [...r].sort((a, b) => {
			if (sortKey === "publishedAt") {
				return new Date(b.publishedAt ?? 0).getTime() - new Date(a.publishedAt ?? 0).getTime();
			}
			return (b.aggregated?.[sortKey] ?? -1) - (a.aggregated?.[sortKey] ?? -1);
		});
		return r;
	}, [rows, filter, sortKey]);

	// Totals across the filtered view.
	const totals = useMemo(() => {
		const t: Record<string, number> = {};
		for (const c of COLS) {
			if (c.key === "engagementRate") continue;
			t[c.key] = view.reduce((s, r) => s + (r.aggregated?.[c.key] ?? 0), 0);
		}
		return t;
	}, [view]);

	async function refresh() {
		setBusy(true);
		try {
			await fetch("/api/analytics/refresh", { method: "POST" });
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3">
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex items-center gap-2">
					<select
						value={filter}
						onChange={(e) => setFilter(e.target.value)}
						className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
					>
						<option value="all">All ecosystems</option>
						{ecosystems.map((e) => (
							<option key={e.id} value={e.id}>
								{e.name}
							</option>
						))}
					</select>
					<select
						value={sortKey}
						onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
						className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
					>
						<option value="publishedAt">Newest</option>
						<option value="impressions">Most impressions</option>
						<option value="likes">Most likes</option>
						<option value="comments">Most comments</option>
						<option value="views">Most views</option>
						<option value="engagementRate">Best engagement</option>
					</select>
				</div>
				<div className="flex items-center gap-3 text-xs opacity-60">
					{lastFetched && <span>Updated {new Date(lastFetched).toLocaleString()}</span>}
					<button
						type="button"
						onClick={refresh}
						disabled={busy}
						className="rounded-md border border-black/15 px-3 py-1.5 hover:bg-black/5 disabled:opacity-40"
					>
						{busy ? "Refreshing…" : "↻ Refresh"}
					</button>
				</div>
			</div>

			{view.length === 0 ? (
				<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
					No analytics yet. Publish a post, then Refresh (metrics may take a while to
					populate on each platform).
				</p>
			) : (
				<div className="overflow-x-auto rounded-lg border border-black/10">
					<table className="w-full text-sm">
						<thead className="bg-black/[0.03] text-left text-xs uppercase tracking-wide opacity-60">
							<tr>
								<th className="px-3 py-2 font-medium">Post</th>
								{COLS.map((c) => (
									<th key={c.key} className="px-3 py-2 text-right font-medium">
										{c.label}
									</th>
								))}
							</tr>
						</thead>
						<tbody>
							{view.map((r) => (
								<Fragment key={r.postpeerPostId}>
									<tr
										className="cursor-pointer border-t border-black/5 hover:bg-black/[0.02]"
										onClick={() =>
											setExpanded(expanded === r.postpeerPostId ? null : r.postpeerPostId)
										}
									>
										<td className="max-w-[280px] px-3 py-2">
											<div className="truncate">{r.content ?? "—"}</div>
											<div className="text-xs opacity-50">
												{r.profileName} · {shortDate(r.publishedAt)}
											</div>
										</td>
										{COLS.map((c) => (
											<td key={c.key} className="px-3 py-2 text-right tabular-nums">
												{fmt(c.key, r.aggregated?.[c.key])}
											</td>
										))}
									</tr>
									{expanded === r.postpeerPostId && (
										<tr className="border-t border-black/5 bg-black/[0.02]">
											<td colSpan={COLS.length + 1} className="px-3 py-2">
												<div className="space-y-1">
													{(r.platforms ?? []).map((p) => (
														<div
															key={p.platform}
															className="flex flex-wrap items-center gap-3 text-xs"
														>
															<span className="w-20 font-medium uppercase">{p.platform}</span>
															{COLS.map((c) => (
																<span key={c.key} className="opacity-70">
																	{c.label} {fmt(c.key, p.metrics?.[c.key])}
																</span>
															))}
															{p.platformPostUrl && (
																<a
																	href={p.platformPostUrl}
																	target="_blank"
																	rel="noreferrer"
																	className="text-primary hover:underline"
																>
																	View →
																</a>
															)}
														</div>
													))}
												</div>
											</td>
										</tr>
									)}
								</Fragment>
							))}
						</tbody>
						<tfoot>
							<tr className="border-t border-black/10 bg-black/[0.03] font-medium">
								<td className="px-3 py-2 text-xs uppercase opacity-60">
									Totals ({view.length})
								</td>
								{COLS.map((c) => (
									<td key={c.key} className="px-3 py-2 text-right tabular-nums">
										{c.key === "engagementRate" ? "—" : (totals[c.key] ?? 0).toLocaleString()}
									</td>
								))}
							</tr>
						</tfoot>
					</table>
				</div>
			)}
		</div>
	);
}
