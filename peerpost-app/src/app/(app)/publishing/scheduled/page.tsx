import Link from "next/link";
import { CancelPostButton } from "@/components/cancel-post-button";
import { PostRow, shortDate } from "@/components/post-row";
import { requirePageUser } from "@/lib/page-auth";
import {
	getPostsPage,
	getPublishSummary,
	type PostRange,
} from "@/lib/queries";
import {
	isPostTypeKey,
	labelForSource,
	POST_TYPE_LABELS,
	POST_TYPE_ORDER,
	type PostTypeKey,
} from "@/lib/post-types";

export const dynamic = "force-dynamic";

type PostStatus = "scheduled" | "published" | "failed" | "cancelled" | "draft";

const STATUS_TABS: { key: string; label: string; statuses?: PostStatus[] }[] = [
	{ key: "scheduled", label: "Scheduled", statuses: ["scheduled"] },
	{ key: "published", label: "Published", statuses: ["published"] },
	{ key: "failed", label: "Failed", statuses: ["failed"] },
	{ key: "cancelled", label: "Cancelled", statuses: ["cancelled"] },
	{ key: "all", label: "All", statuses: undefined },
];

const RANGE_TABS: { key: PostRange; label: string }[] = [
	{ key: "all", label: "Any time" },
	{ key: "overdue", label: "Overdue" },
	{ key: "today", label: "Today" },
	{ key: "next7", label: "Next 7 days" },
	{ key: "upcoming", label: "Upcoming" },
];

type SP = Record<string, string | string[] | undefined>;

function pick(sp: SP, key: string): string | undefined {
	const v = sp[key];
	return Array.isArray(v) ? v[0] : v;
}

/** Build a querystring from the current params with overrides applied. */
function hrefWith(base: SP, overrides: Record<string, string | undefined>) {
	const params = new URLSearchParams();
	for (const [k, v] of Object.entries(base)) {
		const val = Array.isArray(v) ? v[0] : v;
		if (val) params.set(k, val);
	}
	for (const [k, v] of Object.entries(overrides)) {
		if (v === undefined) params.delete(k);
		else params.set(k, v);
	}
	const qs = params.toString();
	return qs ? `?${qs}` : "?";
}

export default async function ScheduledPage({
	searchParams,
}: {
	searchParams: Promise<SP>;
}) {
	const user = await requirePageUser();
	const sp = await searchParams;

	const statusKey = pick(sp, "status") ?? "scheduled";
	const statusTab =
		STATUS_TABS.find((t) => t.key === statusKey) ?? STATUS_TABS[0];

	const typeKey = pick(sp, "type");
	const types: PostTypeKey[] =
		typeKey && isPostTypeKey(typeKey) ? [typeKey] : [];

	const rangeKey = (pick(sp, "range") ?? "all") as PostRange;
	const range = RANGE_TABS.some((r) => r.key === rangeKey) ? rangeKey : "all";

	const page = Math.max(1, Number(pick(sp, "page")) || 1);

	const [summary, result] = await Promise.all([
		getPublishSummary(user, { types, range }),
		getPostsPage(user, {
			statuses: statusTab.statuses,
			types,
			range,
			page,
			order: statusKey === "scheduled" ? "sched-asc" : "created-desc",
		}),
	]);

	const summaryCards = [
		{ label: "Scheduled", n: summary.byStatus.scheduled ?? 0, c: "text-blue-700" },
		{ label: "Published", n: summary.byStatus.published ?? 0, c: "text-green-700" },
		{ label: "Failed", n: summary.byStatus.failed ?? 0, c: "text-red-700" },
		{ label: "Cancelled", n: summary.byStatus.cancelled ?? 0, c: "text-black/50" },
	];

	return (
		<div className="space-y-5">
			<h1 className="text-xl font-semibold">Publishing queue</h1>

			{/* Status summary across the current type/time filter */}
			<div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
				{summaryCards.map((s) => (
					<div key={s.label} className="rounded-lg border border-black/10 p-3">
						<div className={`text-2xl font-semibold ${s.c}`}>
							{s.n.toLocaleString()}
						</div>
						<div className="text-xs opacity-60">{s.label}</div>
					</div>
				))}
			</div>

			{/* Failure breakdown (Part 3) */}
			{summary.failures.length > 0 && (
				<div className="rounded-lg border border-red-200 bg-red-50/40 p-3">
					<div className="mb-2 text-sm font-medium text-red-700">
						Failure reasons
					</div>
					<ul className="flex flex-wrap gap-2 text-xs">
						{summary.failures.map((f) => (
							<li
								key={f.error}
								className="rounded-full bg-white px-2.5 py-1 ring-1 ring-red-200"
							>
								<span className="font-medium">{f.error}</span>
								<span className="ml-1.5 opacity-60">
									{f.count.toLocaleString()}
								</span>
							</li>
						))}
					</ul>
				</div>
			)}

			{/* Status tabs */}
			<nav className="flex flex-wrap gap-1.5 text-sm">
				{STATUS_TABS.map((t) => (
					<Link
						key={t.key}
						href={hrefWith(sp, { status: t.key, page: undefined })}
						className={`rounded-full px-3 py-1 ${
							t.key === statusKey
								? "bg-primary text-white"
								: "bg-black/5 hover:bg-black/10"
						}`}
					>
						{t.label}
					</Link>
				))}
			</nav>

			{/* Content-type + time filters */}
			<div className="flex flex-wrap items-center gap-1.5 text-xs">
				<span className="opacity-50">Type:</span>
				<Link
					href={hrefWith(sp, { type: undefined, page: undefined })}
					className={`rounded-full px-2.5 py-1 ${
						types.length === 0 ? "bg-black/80 text-white" : "bg-black/5 hover:bg-black/10"
					}`}
				>
					All
				</Link>
				{POST_TYPE_ORDER.map((k) => (
					<Link
						key={k}
						href={hrefWith(sp, { type: k, page: undefined })}
						className={`rounded-full px-2.5 py-1 ${
							types[0] === k ? "bg-black/80 text-white" : "bg-black/5 hover:bg-black/10"
						}`}
					>
						{POST_TYPE_LABELS[k]}
					</Link>
				))}
				<span className="ml-3 opacity-50">When:</span>
				{RANGE_TABS.map((r) => (
					<Link
						key={r.key}
						href={hrefWith(sp, { range: r.key, page: undefined })}
						className={`rounded-full px-2.5 py-1 ${
							range === r.key ? "bg-black/80 text-white" : "bg-black/5 hover:bg-black/10"
						}`}
					>
						{r.label}
					</Link>
				))}
			</div>

			{/* Result count */}
			<div className="text-xs opacity-60">
				{result.total.toLocaleString()} {statusTab.label.toLowerCase()} post
				{result.total === 1 ? "" : "s"}
				{types.length ? ` · ${POST_TYPE_LABELS[types[0]]}` : ""}
			</div>

			{/* List */}
			<ul className="space-y-2">
				{result.rows.length === 0 && (
					<li className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
						No posts match these filters.
					</li>
				)}
				{result.rows.map((p) => (
					<PostRow
						key={p.id}
						content={p.content}
						platforms={p.platforms}
						profileName={p.profileName}
						tag={labelForSource(p.source)}
						when={shortDate(p.scheduledFor ?? p.createdAt)}
						status={p.status}
						note={p.status === "failed" ? p.error : null}
						publishedUrl={p.publishedUrl}
						action={
							p.status === "scheduled" ? (
								<CancelPostButton postId={p.id} />
							) : undefined
						}
					/>
				))}
			</ul>

			{/* Pagination */}
			{result.pages > 1 && (
				<div className="flex items-center justify-between pt-1 text-sm">
					<Link
						href={hrefWith(sp, { page: String(result.page - 1) })}
						className={`rounded-lg border border-black/10 px-3 py-1.5 ${
							result.page <= 1
								? "pointer-events-none opacity-40"
								: "hover:bg-black/5"
						}`}
						aria-disabled={result.page <= 1}
					>
						← Prev
					</Link>
					<span className="opacity-60">
						Page {result.page} of {result.pages}
					</span>
					<Link
						href={hrefWith(sp, { page: String(result.page + 1) })}
						className={`rounded-lg border border-black/10 px-3 py-1.5 ${
							result.page >= result.pages
								? "pointer-events-none opacity-40"
								: "hover:bg-black/5"
						}`}
						aria-disabled={result.page >= result.pages}
					>
						Next →
					</Link>
				</div>
			)}
		</div>
	);
}
