"use client";

import { useRouter } from "next/navigation";
import { Fragment, useMemo, useState } from "react";
import type { AnalyticsMetrics } from "@/db/schema";
import { PLATFORM_LABELS } from "@/lib/platform-fields";

type PlatformEntry = {
	platform: string;
	platformPostUrl: string | null;
	metrics: AnalyticsMetrics;
};
type Row = {
	postpeerPostId: string;
	profileId: string;
	profileName: string;
	content: string | null;
	publishedAt: string | null;
	aggregated: AnalyticsMetrics | null;
	platforms: PlatformEntry[] | null;
};

const ZERO: AnalyticsMetrics = {
	impressions: 0,
	reach: 0,
	likes: 0,
	comments: 0,
	shares: 0,
	saves: 0,
	clicks: 0,
	views: 0,
	engagementRate: null,
};

const COUNT_KEYS = [
	"impressions",
	"reach",
	"likes",
	"comments",
	"shares",
	"saves",
	"clicks",
	"views",
] as const;
type CountKey = (typeof COUNT_KEYS)[number];

const num = (v: number | null | undefined) => (typeof v === "number" ? v : 0);
const fmtNum = (v: number) => v.toLocaleString();
const fmtPct = (v: number | null) =>
	v == null ? "—" : `${(v * 100).toFixed(1)}%`;

/** Sum a metric across rows using a metric-extractor (aggregated or per-platform). */
function sumMetric(
	metrics: (AnalyticsMetrics | null | undefined)[],
	key: CountKey,
) {
	return metrics.reduce((s, m) => s + num(m?.[key]), 0);
}
/** Mean engagement rate across the available (non-null) values. */
function avgEngagement(metrics: (AnalyticsMetrics | null | undefined)[]) {
	const vals = metrics
		.map((m) => m?.engagementRate)
		.filter((v): v is number => v != null);
	if (vals.length === 0) return null;
	return vals.reduce((a, b) => a + b, 0) / vals.length;
}

const RANGES = [
	{ key: "7", label: "7 days" },
	{ key: "30", label: "30 days" },
	{ key: "90", label: "90 days" },
	{ key: "all", label: "All time" },
];

export function AnalyticsDashboard({
	rows,
	ecosystems,
	lastFetched,
}: {
	rows: Row[];
	ecosystems: { id: string; name: string }[];
	lastFetched: string | null;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [ecosystem, setEcosystem] = useState("all");
	const [platform, setPlatform] = useState("all");
	const [range, setRange] = useState("30");
	const [sortKey, setSortKey] = useState<
		CountKey | "publishedAt" | "engagementRate"
	>("publishedAt");
	const [expanded, setExpanded] = useState<string | null>(null);

	// Base filter: ecosystem + date range (platform applied later).
	const base = useMemo(() => {
		const cutoff =
			range === "all" ? 0 : Date.now() - Number(range) * 24 * 60 * 60 * 1000;
		return rows.filter((r) => {
			if (ecosystem !== "all" && r.profileId !== ecosystem) return false;
			if (
				cutoff &&
				(!r.publishedAt || new Date(r.publishedAt).getTime() < cutoff)
			)
				return false;
			return true;
		});
	}, [rows, ecosystem, range]);

	// Platforms present in the base set (for the filter dropdown + breakdown).
	const platformsPresent = useMemo(() => {
		const set = new Set<string>();
		for (const r of base)
			for (const p of r.platforms ?? []) set.add(p.platform);
		return [...set];
	}, [base]);

	// Per-platform breakdown (always across all platforms in the base set).
	const breakdown = useMemo(() => {
		return platformsPresent
			.map((plat) => {
				const entries = base
					.map((r) => r.platforms?.find((p) => p.platform === plat)?.metrics)
					.filter((m): m is AnalyticsMetrics => !!m);
				const counts = {} as Record<CountKey, number>;
				for (const k of COUNT_KEYS) counts[k] = sumMetric(entries, k);
				return {
					platform: plat,
					posts: entries.length,
					...counts,
					engagementRate: avgEngagement(entries),
				};
			})
			.sort((a, b) => b.impressions - a.impressions);
	}, [base, platformsPresent]);

	// Rows + metric source respecting the platform filter.
	const view = useMemo(() => {
		const withMetrics = base
			.map((r) => {
				const m =
					platform === "all"
						? (r.aggregated ?? ZERO)
						: r.platforms?.find((p) => p.platform === platform)?.metrics;
				return m ? { row: r, metrics: m } : null;
			})
			.filter((x): x is { row: Row; metrics: AnalyticsMetrics } => !!x);

		withMetrics.sort((a, b) => {
			if (sortKey === "publishedAt")
				return (
					new Date(b.row.publishedAt ?? 0).getTime() -
					new Date(a.row.publishedAt ?? 0).getTime()
				);
			if (sortKey === "engagementRate")
				return num(b.metrics.engagementRate) - num(a.metrics.engagementRate);
			return num(b.metrics[sortKey]) - num(a.metrics[sortKey]);
		});
		return withMetrics;
	}, [base, platform, sortKey]);

	// Cumulative KPIs over the platform-respecting view.
	const kpi = useMemo(() => {
		const metrics = view.map((v) => v.metrics);
		const counts = {} as Record<CountKey, number>;
		for (const k of COUNT_KEYS) counts[k] = sumMetric(metrics, k);
		return {
			posts: view.length,
			...counts,
			engagementRate: avgEngagement(metrics),
		} as Record<string, number | null>;
	}, [view]);

	const topPosts = useMemo(
		() =>
			[...view]
				.sort(
					(a, b) =>
						num(b.metrics.views) +
						num(b.metrics.likes) -
						(num(a.metrics.views) + num(a.metrics.likes)),
				)
				.slice(0, 5),
		[view],
	);

	async function refresh() {
		setBusy(true);
		try {
			await fetch("/api/analytics/refresh", { method: "POST" });
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	const KPI_CARDS: { key: string; label: string; pct?: boolean }[] = [
		{ key: "posts", label: "Posts" },
		{ key: "impressions", label: "Impressions" },
		{ key: "views", label: "Views" },
		{ key: "likes", label: "Likes" },
		{ key: "comments", label: "Comments" },
		{ key: "shares", label: "Shares" },
		{ key: "saves", label: "Saves" },
		{ key: "engagementRate", label: "Avg engagement", pct: true },
	];

	const TABLE_COLS: CountKey[] = [
		"impressions",
		"likes",
		"comments",
		"shares",
		"views",
	];

	return (
		<div className="space-y-6">
			{/* Filters */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex flex-wrap items-center gap-2">
					<select
						value={ecosystem}
						onChange={(e) => setEcosystem(e.target.value)}
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
						value={platform}
						onChange={(e) => setPlatform(e.target.value)}
						className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
					>
						<option value="all">All platforms</option>
						{platformsPresent.map((p) => (
							<option key={p} value={p}>
								{PLATFORM_LABELS[p] ?? p}
							</option>
						))}
					</select>
					<div className="flex rounded-md border border-black/15 text-sm">
						{RANGES.map((r) => (
							<button
								type="button"
								key={r.key}
								onClick={() => setRange(r.key)}
								className={`px-2.5 py-1.5 ${range === r.key ? "bg-primary text-white" : "hover:bg-black/5"}`}
							>
								{r.label}
							</button>
						))}
					</div>
				</div>
				<div className="flex items-center gap-3 text-xs opacity-60">
					{lastFetched && (
						<span>Updated {new Date(lastFetched).toLocaleString()}</span>
					)}
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

			{/* KPI cards */}
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				{KPI_CARDS.map((c) => (
					<div key={c.key} className="rounded-lg border border-black/10 p-3">
						<div className="text-xs uppercase tracking-wide opacity-50">
							{c.label}
						</div>
						<div className="mt-1 text-xl font-semibold tabular-nums">
							{c.pct ? fmtPct(kpi.engagementRate) : fmtNum(num(kpi[c.key]))}
						</div>
					</div>
				))}
			</div>

			{/* Per-platform overview */}
			<section>
				<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-50">
					By platform
				</h2>
				<div className="overflow-x-auto rounded-lg border border-black/10">
					<table className="w-full text-sm">
						<thead className="bg-black/[0.03] text-left text-xs uppercase tracking-wide opacity-60">
							<tr>
								<th className="px-3 py-2 font-medium">Platform</th>
								<th className="px-3 py-2 text-right font-medium">Posts</th>
								{TABLE_COLS.map((k) => (
									<th
										key={k}
										className="px-3 py-2 text-right font-medium capitalize"
									>
										{k}
									</th>
								))}
								<th className="px-3 py-2 text-right font-medium">Avg eng.</th>
							</tr>
						</thead>
						<tbody>
							{breakdown.length === 0 && (
								<tr>
									<td
										colSpan={TABLE_COLS.length + 3}
										className="px-3 py-6 text-center opacity-50"
									>
										No data in this range.
									</td>
								</tr>
							)}
							{breakdown.map((b) => (
								<tr key={b.platform} className="border-t border-black/5">
									<td className="px-3 py-2 font-medium">
										{PLATFORM_LABELS[b.platform] ?? b.platform}
									</td>
									<td className="px-3 py-2 text-right tabular-nums">
										{b.posts}
									</td>
									{TABLE_COLS.map((k) => (
										<td key={k} className="px-3 py-2 text-right tabular-nums">
											{fmtNum(num(b[k]))}
										</td>
									))}
									<td className="px-3 py-2 text-right tabular-nums">
										{fmtPct(b.engagementRate)}
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			{/* Top posts */}
			{topPosts.length > 0 && (
				<section>
					<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-50">
						Top posts
					</h2>
					<ol className="space-y-1">
						{topPosts.map((v, i) => (
							<li
								key={v.row.postpeerPostId}
								className="flex items-center gap-3 rounded-md border border-black/10 px-3 py-2 text-sm"
							>
								<span className="w-4 text-center opacity-40">{i + 1}</span>
								<span className="min-w-0 flex-1 truncate">
									{v.row.content ?? "—"}
								</span>
								<span className="shrink-0 text-xs opacity-60">
									▶ {fmtNum(num(v.metrics.views))} · ♥{" "}
									{fmtNum(num(v.metrics.likes))} ·{" "}
									{fmtPct(v.metrics.engagementRate)}
								</span>
							</li>
						))}
					</ol>
				</section>
			)}

			{/* Posts table */}
			<section>
				<div className="mb-2 flex items-center justify-between">
					<h2 className="text-sm font-semibold uppercase tracking-wide opacity-50">
						Posts ({view.length})
					</h2>
					<select
						value={sortKey}
						onChange={(e) => setSortKey(e.target.value as typeof sortKey)}
						className="rounded-md border border-black/15 px-2 py-1 text-xs"
					>
						<option value="publishedAt">Newest</option>
						<option value="impressions">Most impressions</option>
						<option value="views">Most views</option>
						<option value="likes">Most likes</option>
						<option value="comments">Most comments</option>
						<option value="engagementRate">Best engagement</option>
					</select>
				</div>
				<div className="overflow-x-auto rounded-lg border border-black/10">
					<table className="w-full text-sm">
						<thead className="bg-black/[0.03] text-left text-xs uppercase tracking-wide opacity-60">
							<tr>
								<th className="px-3 py-2 font-medium">Post</th>
								{TABLE_COLS.map((k) => (
									<th
										key={k}
										className="px-3 py-2 text-right font-medium capitalize"
									>
										{k}
									</th>
								))}
								<th className="px-3 py-2 text-right font-medium">Eng.</th>
							</tr>
						</thead>
						<tbody>
							{view.length === 0 && (
								<tr>
									<td
										colSpan={TABLE_COLS.length + 2}
										className="px-3 py-6 text-center opacity-50"
									>
										No posts match these filters.
									</td>
								</tr>
							)}
							{view.map((v) => (
								<Fragment key={v.row.postpeerPostId}>
									<tr
										className="cursor-pointer border-t border-black/5 hover:bg-black/[0.02]"
										onClick={() =>
											setExpanded(
												expanded === v.row.postpeerPostId
													? null
													: v.row.postpeerPostId,
											)
										}
									>
										<td className="max-w-[260px] px-3 py-2">
											<div className="truncate">{v.row.content ?? "—"}</div>
											<div className="text-xs opacity-50">
												{v.row.profileName} ·{" "}
												{v.row.publishedAt
													? new Date(v.row.publishedAt).toLocaleDateString()
													: "—"}
											</div>
										</td>
										{TABLE_COLS.map((k) => (
											<td key={k} className="px-3 py-2 text-right tabular-nums">
												{fmtNum(num(v.metrics[k]))}
											</td>
										))}
										<td className="px-3 py-2 text-right tabular-nums">
											{fmtPct(v.metrics.engagementRate)}
										</td>
									</tr>
									{expanded === v.row.postpeerPostId && (
										<tr className="border-t border-black/5 bg-black/[0.02]">
											<td colSpan={TABLE_COLS.length + 2} className="px-3 py-2">
												<div className="space-y-1">
													{(v.row.platforms ?? []).map((p) => (
														<div
															key={p.platform}
															className="flex flex-wrap items-center gap-3 text-xs"
														>
															<span className="w-24 font-medium">
																{PLATFORM_LABELS[p.platform] ?? p.platform}
															</span>
															{TABLE_COLS.map((k) => (
																<span key={k} className="opacity-70 capitalize">
																	{k} {fmtNum(num(p.metrics?.[k]))}
																</span>
															))}
															<span className="opacity-70">
																eng {fmtPct(p.metrics?.engagementRate)}
															</span>
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
					</table>
				</div>
			</section>
		</div>
	);
}
