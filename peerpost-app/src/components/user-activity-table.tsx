"use client";

import { useMemo, useState } from "react";
import { PLATFORM_SHORT } from "@/lib/platform-fields";
import type { UserDailyActivity } from "@/lib/queries";

type SortKey = "email" | "day" | "posts" | "dubbed" | "shorts" | "total";

const COLUMNS: { key: SortKey; label: string; numeric: boolean }[] = [
	{ key: "email", label: "User", numeric: false },
	{ key: "day", label: "Day", numeric: false },
	{ key: "posts", label: "Posts", numeric: true },
	{ key: "dubbed", label: "Dubbed", numeric: true },
	{ key: "shorts", label: "Shorts", numeric: true },
	{ key: "total", label: "Total (D+S)", numeric: true },
];

/**
 * Sortable per-user, per-day publishing table. Click a header to sort; click
 * again to flip direction. Defaults to most-recent day, then most posts.
 */
export function UserActivityTable({
	rows,
}: {
	readonly rows: UserDailyActivity[];
}) {
	const [sortKey, setSortKey] = useState<SortKey>("day");
	const [asc, setAsc] = useState(false);

	const sorted = useMemo(() => {
		const copy = [...rows];
		copy.sort((a, b) => {
			let cmp: number;
			if (sortKey === "email") cmp = a.email.localeCompare(b.email);
			else if (sortKey === "day") cmp = a.day.localeCompare(b.day);
			else cmp = a[sortKey] - b[sortKey];
			if (cmp === 0) cmp = b.posts - a.posts;
			return asc ? cmp : -cmp;
		});
		return copy;
	}, [rows, sortKey, asc]);

	const totals = useMemo(
		() =>
			rows.reduce(
				(t, r) => {
					t.posts += r.posts;
					t.dubbed += r.dubbed;
					t.shorts += r.shorts;
					t.total += r.total;
					return t;
				},
				{ posts: 0, dubbed: 0, shorts: 0, total: 0 },
			),
		[rows],
	);

	function toggle(key: SortKey) {
		if (key === sortKey) setAsc((v) => !v);
		else {
			setSortKey(key);
			setAsc(false);
		}
	}

	if (rows.length === 0) {
		return (
			<p className="text-sm opacity-50">
				No published posts in this window yet.
			</p>
		);
	}

	return (
		<div className="overflow-x-auto">
			<table className="w-full text-sm">
				<thead className="text-left text-xs uppercase tracking-wide opacity-50">
					<tr>
						{COLUMNS.map((c) => (
							<th key={c.key} className="px-2 py-2 font-medium">
								<button
									type="button"
									onClick={() => toggle(c.key)}
									className={`inline-flex items-center gap-1 hover:opacity-100 ${
										sortKey === c.key ? "opacity-100" : "opacity-70"
									}`}
								>
									{c.label}
									<span className="text-[9px]">
										{sortKey === c.key ? (asc ? "▲" : "▼") : "↕"}
									</span>
								</button>
							</th>
						))}
						<th className="px-2 py-2 font-medium">Platforms</th>
					</tr>
				</thead>
				<tbody>
					{sorted.map((r) => (
						<tr key={`${r.email}-${r.day}`} className="border-t border-black/5">
							<td className="px-2 py-2">{r.email}</td>
							<td className="px-2 py-2 whitespace-nowrap opacity-70">
								{r.dayLabel}
							</td>
							<td className="px-2 py-2 font-medium tabular-nums">{r.posts}</td>
							<td className="px-2 py-2 tabular-nums">
								{r.dubbed || <span className="opacity-30">0</span>}
							</td>
							<td className="px-2 py-2 tabular-nums">
								{r.shorts || <span className="opacity-30">0</span>}
							</td>
							<td className="px-2 py-2 font-medium tabular-nums">
								{r.total || <span className="opacity-30">0</span>}
							</td>
							<td className="px-2 py-2">
								<span className="flex flex-wrap gap-1">
									{r.platforms.map((p) => (
										<span
											key={p}
											className="rounded bg-black/5 px-1 py-0.5 text-[10px]"
											title={p}
										>
											{PLATFORM_SHORT[p] ?? p}
										</span>
									))}
								</span>
							</td>
						</tr>
					))}
				</tbody>
				<tfoot>
					<tr className="border-t border-black/10 font-medium">
						<td className="px-2 py-2" colSpan={2}>
							{rows.length} rows
						</td>
						<td className="px-2 py-2 tabular-nums">{totals.posts}</td>
						<td className="px-2 py-2 tabular-nums">{totals.dubbed}</td>
						<td className="px-2 py-2 tabular-nums">{totals.shorts}</td>
						<td className="px-2 py-2 tabular-nums">{totals.total}</td>
						<td className="px-2 py-2" />
					</tr>
				</tfoot>
			</table>
		</div>
	);
}
