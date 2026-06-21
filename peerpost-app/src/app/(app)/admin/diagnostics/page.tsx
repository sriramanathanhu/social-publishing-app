import {
	CATEGORY_LABEL,
	getDiagnostics,
	type IssueCategory,
} from "@/lib/diagnostics";
import { requireAdminPage } from "@/lib/page-auth";

/**
 * Admin → Diagnostics: a status page that turns the failure text stored on every
 * dub/shorts job into a classified, per-user view, so you can tell at a glance
 * whether an issue is a user's API key, the source video, or the server.
 */
export default async function DiagnosticsPage() {
	await requireAdminPage();
	const { health, failures, userSummary, windowHours } = await getDiagnostics();

	const serverFails = failures.filter(
		(f) => CATEGORY_LABEL[f.category].server,
	).length;
	const keyFails = failures.filter((f) => f.category.startsWith("key_")).length;

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-xl font-semibold">Diagnostics</h1>
				<p className="mt-1 text-sm opacity-60">
					Service health and classified failures over the last {windowHours}h.
				</p>
			</div>

			{/* Service health */}
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
				<HealthCard ok={health.dubberOk} label="Dubber service" />
				<HealthCard ok={health.r2Configured} label="R2 storage" />
				<StatCard
					label="Running now"
					value={`${health.runningDubs + health.runningShorts}`}
					hint={`${health.runningDubs} dub · ${health.runningShorts} short`}
					warn={health.runningDubs + health.runningShorts >= 6}
				/>
				<StatCard
					label="Failures / server"
					value={`${failures.length} / ${serverFails}`}
					hint={`${keyFails} are API-key issues`}
					warn={serverFails > 0}
				/>
			</div>

			{/* Per-user summary */}
			<section className="space-y-2">
				<h2 className="text-sm font-semibold opacity-70">
					Per-user activity ({windowHours}h)
				</h2>
				<div className="overflow-x-auto rounded-lg border border-black/10">
					<table className="w-full text-sm">
						<thead className="bg-black/[0.03] text-left text-xs uppercase tracking-wide opacity-60">
							<tr>
								<th className="px-3 py-2 font-medium">User</th>
								<th className="px-3 py-2 font-medium">Dubs ✓/✗</th>
								<th className="px-3 py-2 font-medium">Shorts ✓/✗</th>
								<th className="px-3 py-2 font-medium">Top issue</th>
								<th className="px-3 py-2 font-medium">Keys set</th>
							</tr>
						</thead>
						<tbody>
							{userSummary.length === 0 && (
								<tr>
									<td colSpan={5} className="px-3 py-6 text-center opacity-50">
										No activity in this window.
									</td>
								</tr>
							)}
							{userSummary.map((u) => (
								<tr key={u.email} className="border-t border-black/5">
									<td className="px-3 py-2">
										{u.email}
										{u.role === "admin" && (
											<span className="ml-1 text-xs text-primary">admin</span>
										)}
									</td>
									<td className="px-3 py-2">
										<span className="text-green-600">{u.dubDone}</span>
										{" / "}
										<span
											className={u.dubFailed ? "text-red-600" : "opacity-40"}
										>
											{u.dubFailed}
										</span>
									</td>
									<td className="px-3 py-2">
										<span className="text-green-600">{u.shortDone}</span>
										{" / "}
										<span
											className={u.shortFailed ? "text-red-600" : "opacity-40"}
										>
											{u.shortFailed}
										</span>
									</td>
									<td className="px-3 py-2">
										{u.topIssue ? <IssueBadge category={u.topIssue} /> : "—"}
									</td>
									<td className="px-3 py-2 text-xs">
										<KeyDots keys={u.keys} />
									</td>
								</tr>
							))}
						</tbody>
					</table>
				</div>
			</section>

			{/* Recent failures */}
			<section className="space-y-2">
				<h2 className="text-sm font-semibold opacity-70">
					Recent failures ({failures.length})
				</h2>
				{failures.length === 0 ? (
					<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
						No failures in the last {windowHours}h. 🎉
					</p>
				) : (
					<div className="space-y-2">
						{failures.slice(0, 60).map((f) => (
							<div
								key={`${f.email}-${f.at.getTime()}-${f.error.slice(0, 12)}`}
								className="rounded-lg border border-black/10 bg-white p-3 text-sm shadow-sm"
							>
								<div className="flex flex-wrap items-center gap-2">
									<span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px] font-medium">
										{f.type}
									</span>
									<IssueBadge category={f.category} />
									{f.provider && (
										<span className="rounded bg-black/5 px-1.5 py-0.5 text-[11px]">
											{f.provider}
										</span>
									)}
									<span className="text-xs opacity-60">{f.email}</span>
									{f.stage && (
										<span className="text-xs opacity-40">@ {f.stage}</span>
									)}
									<span className="ml-auto text-xs opacity-40">
										{f.at.toLocaleString()}
									</span>
								</div>
								<p className="mt-1.5 line-clamp-2 font-mono text-[11px] opacity-60">
									{f.error}
								</p>
								<p className="mt-1 text-[11px] opacity-50">
									→ {CATEGORY_LABEL[f.category].fix}
								</p>
							</div>
						))}
					</div>
				)}
			</section>
		</div>
	);
}

function HealthCard({ ok, label }: { ok: boolean; label: string }) {
	return (
		<div className="rounded-lg border border-black/10 bg-white p-3 shadow-sm">
			<div className="text-xs opacity-50">{label}</div>
			<div
				className={`mt-1 text-sm font-medium ${ok ? "text-green-600" : "text-red-600"}`}
			>
				{ok ? "● Up" : "● Down"}
			</div>
		</div>
	);
}

function StatCard({
	label,
	value,
	hint,
	warn,
}: {
	label: string;
	value: string;
	hint?: string;
	warn?: boolean;
}) {
	return (
		<div className="rounded-lg border border-black/10 bg-white p-3 shadow-sm">
			<div className="text-xs opacity-50">{label}</div>
			<div
				className={`mt-1 text-sm font-medium ${warn ? "text-amber-600" : ""}`}
			>
				{value}
			</div>
			{hint && <div className="text-[11px] opacity-40">{hint}</div>}
		</div>
	);
}

function IssueBadge({ category }: { category: IssueCategory }) {
	const server = CATEGORY_LABEL[category].server;
	const cls = category.startsWith("key_")
		? "bg-red-100 text-red-700"
		: server
			? "bg-amber-100 text-amber-700"
			: "bg-sky-100 text-sky-700";
	return (
		<span className={`rounded px-1.5 py-0.5 text-[11px] font-medium ${cls}`}>
			{CATEGORY_LABEL[category].label}
		</span>
	);
}

function KeyDots({
	keys,
}: {
	keys: {
		deepgram: boolean;
		gemini: boolean;
		nvidia: boolean;
		cookies: boolean;
	};
}) {
	const items: [string, boolean][] = [
		["Deepgram", keys.deepgram],
		["Gemini", keys.gemini],
		["NVIDIA", keys.nvidia],
		["Cookies", keys.cookies],
	];
	return (
		<span className="flex flex-wrap gap-1">
			{items.map(([name, on]) => (
				<span
					key={name}
					title={on ? `${name} set` : `${name} not set`}
					className={`rounded px-1 py-0.5 text-[10px] ${on ? "bg-green-100 text-green-700" : "bg-black/5 opacity-50"}`}
				>
					{name}
				</span>
			))}
		</span>
	);
}
