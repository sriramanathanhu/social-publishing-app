import Link from "next/link";
import { PostRow, shortDate } from "@/components/post-row";
import { UserActivityTable } from "@/components/user-activity-table";
import { requirePageUser } from "@/lib/page-auth";
import { PLATFORM_LABELS } from "@/lib/platform-fields";
import { getPublishingInsights, getUserDailyActivity } from "@/lib/queries";

const nf = new Intl.NumberFormat();
const platformLabel = (p: string) => PLATFORM_LABELS[p] ?? p;

/** Publishing overview — an insights dashboard (volume, success, reach mix,
 * activity, engagement) with the recent posts below, not just a list of links. */
export default async function OverviewPage() {
	const user = await requirePageUser();
	const [ins, activity] = await Promise.all([
		getPublishingInsights(user),
		getUserDailyActivity(user, 30),
	]);

	const wow =
		ins.week.previous > 0
			? Math.round(
					((ins.week.current - ins.week.previous) / ins.week.previous) * 100,
				)
			: null;

	return (
		<div className="space-y-6">
			<div className="flex items-center justify-between">
				<div>
					<h1 className="text-xl font-semibold">Publishing overview</h1>
					<p className="mt-0.5 text-sm opacity-60">
						Across your assigned ecosystems.
					</p>
				</div>
				<Link
					href="/publishing/create"
					className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-white"
				>
					+ Create Post
				</Link>
			</div>

			{!ins.hasAccess ? (
				<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
					You don't have any assigned ecosystems yet.
				</p>
			) : ins.totals.published + ins.totals.scheduled + ins.totals.failed ===
				0 ? (
				<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
					Nothing published yet. Create your first post.
				</p>
			) : (
				<>
					{/* KPIs */}
					<div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
						<Kpi
							label="Published"
							value={nf.format(ins.totals.published)}
							sub={
								wow === null
									? `${ins.week.current} this week`
									: `${ins.week.current} this week · ${wow >= 0 ? "+" : ""}${wow}% WoW`
							}
							subTone={wow === null ? "muted" : wow >= 0 ? "up" : "down"}
						/>
						<Kpi
							label="Scheduled"
							value={nf.format(ins.totals.scheduled)}
							sub="upcoming"
							subTone="muted"
						/>
						<Kpi
							label="Success rate"
							value={
								ins.successRate === null
									? "—"
									: `${Math.round(ins.successRate * 100)}%`
							}
							sub={`${ins.totals.failed} failed`}
							subTone={ins.totals.failed > 0 ? "down" : "muted"}
						/>
						<Kpi
							label="Provider mix"
							value={`${ins.byProvider.postpeer}/${ins.byProvider.zernio}`}
							sub="PostPeer / Zernio"
							subTone="muted"
						/>
					</div>

					{/* Activity sparkline */}
					<Card title="Activity — last 14 days">
						<Activity data={ins.activity} />
					</Card>

					{/* Breakdowns */}
					<div className="grid gap-3 lg:grid-cols-2">
						<Card title="Published by platform">
							<BarList
								items={ins.byPlatform.map((p) => ({
									label: platformLabel(p.platform),
									count: p.count,
								}))}
							/>
						</Card>
						<Card title="Published by ecosystem">
							<BarList
								items={ins.byEcosystem.map((e) => ({
									label: e.name,
									count: e.count,
								}))}
							/>
						</Card>
					</div>

					{/* Engagement (tracked subset) */}
					<Card
						title="Engagement"
						hint={
							ins.engagement.tracked > 0
								? `from ${ins.engagement.tracked} tracked post${ins.engagement.tracked === 1 ? "" : "s"}`
								: undefined
						}
					>
						{ins.engagement.tracked === 0 ? (
							<p className="text-sm opacity-50">
								No analytics synced yet — engagement appears here once posts are
								tracked.
							</p>
						) : (
							<div className="space-y-3">
								<div className="flex gap-6">
									<Metric
										label="Views"
										value={nf.format(ins.engagement.views)}
									/>
									<Metric
										label="Likes"
										value={nf.format(ins.engagement.likes)}
									/>
								</div>
								{ins.engagement.top.some((t) => t.views > 0) && (
									<div>
										<div className="mb-1 text-xs font-medium uppercase tracking-wide opacity-40">
											Top by views
										</div>
										<ul className="space-y-1">
											{ins.engagement.top
												.filter((t) => t.views > 0)
												.map((t) => (
													<li
														key={t.title + t.views}
														className="flex items-center justify-between gap-3 text-sm"
													>
														<span className="min-w-0 truncate opacity-80">
															{t.url ? (
																<a
																	href={t.url}
																	target="_blank"
																	rel="noopener noreferrer"
																	className="hover:underline"
																>
																	{t.title}
																</a>
															) : (
																t.title
															)}
														</span>
														<span className="shrink-0 opacity-60">
															▶ {nf.format(t.views)}
														</span>
													</li>
												))}
										</ul>
									</div>
								)}
							</div>
						)}
					</Card>

					{/* Upcoming scheduled */}
					{ins.upcoming.length > 0 && (
						<Card title="Upcoming scheduled">
							<ul className="space-y-2">
								{ins.upcoming.map((u) => (
									<li key={u.id} className="flex items-center gap-3 text-sm">
										<span className="shrink-0 rounded bg-black/5 px-1.5 py-0.5 text-xs">
											{shortDate(u.when)}
										</span>
										<span className="flex shrink-0 gap-1">
											{u.platforms.map((p, i) => (
												<span
													key={`${p.platform}-${i}`}
													className="rounded bg-black/5 px-1 py-0.5 text-[10px] uppercase"
												>
													{p.platform}
												</span>
											))}
										</span>
										<span className="min-w-0 flex-1 truncate opacity-70">
											{u.content ?? "—"}
										</span>
										<span className="shrink-0 text-xs opacity-40">
											{u.profileName}
										</span>
									</li>
								))}
							</ul>
						</Card>
					)}

					{/* Per-user daily activity (sortable) */}
					<Card
						title="Who published what — by user & day"
						hint="last 30 days · click a header to sort"
					>
						<UserActivityTable rows={activity} />
					</Card>

					{/* Recent published */}
					<div className="space-y-2">
						<div className="flex items-center justify-between">
							<h2 className="text-sm font-semibold opacity-70">
								Recent published
							</h2>
							<Link
								href="/publishing/scheduled"
								className="text-xs text-primary hover:underline"
							>
								View scheduled →
							</Link>
						</div>
						<ul className="space-y-2">
							{ins.recent.map((p) => (
								<PostRow
									key={p.id}
									content={p.content}
									platforms={p.platforms}
									profileName={p.profileName}
									when={shortDate(p.createdAt)}
									status={p.status}
									publishedUrl={p.publishedUrl}
									metrics={p.metrics}
								/>
							))}
						</ul>
					</div>
				</>
			)}
		</div>
	);
}

function Kpi({
	label,
	value,
	sub,
	subTone,
}: {
	label: string;
	value: string;
	sub: string;
	subTone: "up" | "down" | "muted";
}) {
	const tone =
		subTone === "up"
			? "text-green-600"
			: subTone === "down"
				? "text-red-600"
				: "opacity-40";
	return (
		<div className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
			<div className="text-xs uppercase tracking-wide opacity-50">{label}</div>
			<div className="mt-1 text-2xl font-semibold">{value}</div>
			<div className={`mt-0.5 text-xs ${tone}`}>{sub}</div>
		</div>
	);
}

function Card({
	title,
	hint,
	children,
}: {
	title: string;
	hint?: string;
	children: React.ReactNode;
}) {
	return (
		<div className="rounded-xl border border-black/10 bg-white p-4 shadow-sm">
			<div className="mb-3 flex items-baseline justify-between">
				<h2 className="text-sm font-semibold opacity-70">{title}</h2>
				{hint && <span className="text-xs opacity-40">{hint}</span>}
			</div>
			{children}
		</div>
	);
}

function Metric({ label, value }: { label: string; value: string }) {
	return (
		<div>
			<div className="text-xl font-semibold">{value}</div>
			<div className="text-xs uppercase tracking-wide opacity-40">{label}</div>
		</div>
	);
}

function BarList({ items }: { items: { label: string; count: number }[] }) {
	if (items.length === 0)
		return <p className="text-sm opacity-50">No published posts yet.</p>;
	const max = Math.max(...items.map((i) => i.count), 1);
	return (
		<div className="space-y-1.5">
			{items.map((i) => (
				<div key={i.label} className="flex items-center gap-2 text-sm">
					<span className="w-28 shrink-0 truncate opacity-70">{i.label}</span>
					<div className="h-4 flex-1 overflow-hidden rounded bg-black/[0.04]">
						<div
							className="h-full rounded bg-primary/70"
							style={{ width: `${Math.max((i.count / max) * 100, 3)}%` }}
						/>
					</div>
					<span className="w-10 shrink-0 text-right tabular-nums opacity-60">
						{i.count}
					</span>
				</div>
			))}
		</div>
	);
}

function Activity({ data }: { data: { label: string; count: number }[] }) {
	const max = Math.max(...data.map((d) => d.count), 1);
	const total = data.reduce((n, d) => n + d.count, 0);
	return (
		<div>
			<div className="flex h-24 items-end gap-1">
				{data.map((d) => (
					<div
						key={d.label}
						className="group flex flex-1 flex-col items-center justify-end"
						title={`${d.label}: ${d.count}`}
					>
						<div
							className="w-full rounded-t bg-primary/70 transition-all group-hover:bg-primary"
							style={{ height: `${Math.max((d.count / max) * 100, 2)}%` }}
						/>
					</div>
				))}
			</div>
			<div className="mt-1 flex justify-between text-[10px] opacity-40">
				<span>{data[0]?.label}</span>
				<span>{total} posts</span>
				<span>{data[data.length - 1]?.label}</span>
			</div>
		</div>
	);
}
