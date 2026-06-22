"use client";

import { useState } from "react";
import {
	type Ecosystem,
	type Provider,
	readJson,
} from "@/components/publish-row";

/** Platforms that accept a text-only post (no media). Quotes target these. */
const TEXT_PLATFORMS = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"bluesky",
	"threads",
	"reddit",
	"telegram",
	"discord",
	"whatsapp",
	"googlebusiness",
]);

const PROVIDER_LABEL: Record<Provider, string> = {
	postpeer: "PostPeer",
	zernio: "Zernio",
};

type RowResult = {
	platform: string;
	status: "publishing" | "published" | "scheduled" | "failed";
	error?: string;
	url?: string;
};

/**
 * One generated quote: editable text + suggested hashtags, with an inline
 * publish/schedule composer scoped to the viewer's ecosystems and to
 * TEXT-capable accounts (a quote has no media). Mirrors PublishRow's background
 * publish + status polling, minus the media handling.
 */
export function QuoteRow({
	initialText,
	hashtags,
	ecosystems,
}: {
	readonly initialText: string;
	readonly hashtags: string[];
	readonly ecosystems: Ecosystem[];
}) {
	const [text, setText] = useState(initialText);
	const [includeTags, setIncludeTags] = useState(hashtags.length > 0);
	const [ecoId, setEcoId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [provider, setProvider] = useState<Provider>("postpeer");
	const [scheduledFor, setScheduledFor] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<RowResult[]>([]);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const textAccounts = (eco?.accounts ?? []).filter((a) =>
		TEXT_PLATFORMS.has(a.platform),
	);
	const providers = Array.from(
		new Set(textAccounts.map((a) => a.provider ?? "postpeer")),
	) as Provider[];
	const showProviderToggle = providers.length > 1;
	const visibleAccounts = textAccounts.filter((a) =>
		showProviderToggle ? (a.provider ?? "postpeer") === provider : true,
	);

	const tagLine = hashtags.map((h) => `#${h}`).join(" ");
	const body = includeTags && tagLine ? `${text}\n\n${tagLine}` : text;
	const chars = body.length;

	function pickEco(id: string) {
		setEcoId(id);
		setSelected(new Set());
		setResults([]);
		setMsg(null);
		const e = ecosystems.find((x) => x.id === id);
		const provs = Array.from(
			new Set(
				(e?.accounts ?? [])
					.filter((a) => TEXT_PLATFORMS.has(a.platform))
					.map((a) => a.provider ?? "postpeer"),
			),
		) as Provider[];
		setProvider(
			provs.includes("postpeer") ? "postpeer" : (provs[0] ?? "postpeer"),
		);
	}

	function toggle(accountId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(accountId)) next.delete(accountId);
			else next.add(accountId);
			return next;
		});
	}

	async function publish() {
		const targets = visibleAccounts
			.filter((a) => selected.has(a.accountId))
			.map((a) => ({ platform: a.platform, accountId: a.accountId }));
		if (targets.length === 0) {
			setMsg("Select at least one account.");
			return;
		}
		if (!body.trim()) {
			setMsg("Quote is empty.");
			return;
		}
		setBusy(true);
		setMsg(null);
		setResults([]);
		let jobs: { id: string; platform: string }[] = [];
		try {
			const res = await fetch(`/api/profiles/${ecoId}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: body,
					platforms: targets,
					publishNow: scheduledFor ? undefined : true,
					scheduledFor: scheduledFor
						? new Date(scheduledFor).toISOString()
						: undefined,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					source: "quote",
				}),
			});
			const d = await readJson(res);
			if (!res.ok) throw new Error(d.error ?? "Publish failed");
			jobs = d.jobs ?? [];
			if (jobs.length === 0) throw new Error("Nothing was queued to publish.");
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
			setBusy(false);
			return;
		}
		setResults(
			jobs.map((j) => ({ platform: j.platform, status: "publishing" })),
		);
		setMsg(scheduledFor ? "Scheduling…" : "Publishing…");
		pollStatuses(jobs, !!scheduledFor);
	}

	function pollStatuses(
		jobs: { id: string; platform: string }[],
		sched: boolean,
	) {
		const ids = jobs.map((j) => j.id).join(",");
		const started = Date.now();
		const tick = async () => {
			try {
				const r = await fetch(`/api/profiles/${ecoId}/posts/status?ids=${ids}`);
				const d = await readJson(r);
				const byId = new Map((d.statuses ?? []).map((s) => [s.id, s]));
				const updated: RowResult[] = jobs.map((j) => {
					const st = byId.get(j.id)?.status ?? "publishing";
					const status =
						st === "published" || st === "scheduled" || st === "failed"
							? (st as RowResult["status"])
							: "publishing";
					return {
						platform: j.platform,
						status,
						error: byId.get(j.id)?.error ?? undefined,
						url: byId.get(j.id)?.url ?? undefined,
					};
				});
				setResults(updated);
				const pending = updated.some(
					(u) =>
						u.status === "publishing" || (u.status === "published" && !u.url),
				);
				if (pending && Date.now() - started < 180_000) {
					setTimeout(tick, 3000);
					return;
				}
				const failed = updated.filter((u) => u.status === "failed").length;
				setMsg(
					failed
						? `${updated.length - failed}/${updated.length} ${sched ? "scheduled" : "published"} · ${failed} failed`
						: sched
							? "Scheduled ✓"
							: "Published ✓",
				);
				setBusy(false);
			} catch {
				if (Date.now() - started < 180_000) setTimeout(tick, 4000);
				else {
					setMsg("Lost track of publish status — check the post log.");
					setBusy(false);
				}
			}
		};
		setTimeout(tick, 2000);
	}

	return (
		<div className="rounded-xl border border-black/10 bg-white p-3 shadow-sm">
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				rows={3}
				className="w-full resize-y rounded-md border border-black/15 px-3 py-2 text-sm"
			/>
			<div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs">
				{hashtags.length > 0 && (
					<label className="flex items-center gap-1 opacity-70">
						<input
							type="checkbox"
							checked={includeTags}
							onChange={(e) => setIncludeTags(e.target.checked)}
						/>
						{hashtags.map((h) => `#${h}`).join(" ")}
					</label>
				)}
				<span
					className={`ml-auto tabular-nums ${chars > 280 ? "text-amber-600" : "opacity-40"}`}
				>
					{chars} chars
				</span>
			</div>

			<div className="mt-2 border-t border-black/5 pt-2">
				<select
					value={ecoId}
					onChange={(e) => pickEco(e.target.value)}
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
				>
					<option value="">Publish to ecosystem…</option>
					{ecosystems.map((e) => (
						<option key={e.id} value={e.id}>
							{e.teamName} › {e.name}
						</option>
					))}
				</select>

				{eco && (
					<div className="mt-2 space-y-2">
						{showProviderToggle && (
							<div className="flex items-center gap-1 text-xs">
								<span className="opacity-50">Via:</span>
								{providers.map((p) => (
									<button
										type="button"
										key={p}
										onClick={() => {
											setProvider(p);
											setSelected(new Set());
										}}
										className={`rounded px-2 py-0.5 ${provider === p ? "bg-primary text-white" : "border border-black/15 hover:bg-black/5"}`}
									>
										{PROVIDER_LABEL[p]}
									</button>
								))}
							</div>
						)}

						{visibleAccounts.length === 0 ? (
							<p className="text-xs opacity-50">
								No text-capable accounts here (quotes post to X, LinkedIn,
								Facebook, Bluesky, Threads, …).
							</p>
						) : (
							<div className="flex flex-wrap gap-2">
								{visibleAccounts.map((a) => (
									<button
										type="button"
										key={a.accountId}
										onClick={() => toggle(a.accountId)}
										className={`rounded-full border px-3 py-1 text-xs ${
											selected.has(a.accountId)
												? "border-primary bg-primary text-white"
												: "border-black/15 hover:bg-black/5"
										}`}
									>
										{a.platform}
										{a.handle ? ` · ${a.handle}` : ""}
									</button>
								))}
							</div>
						)}

						<div className="flex flex-wrap items-center gap-3">
							<label className="text-xs opacity-60">
								Schedule (optional){" "}
								<input
									type="datetime-local"
									value={scheduledFor}
									onChange={(e) => setScheduledFor(e.target.value)}
									className="rounded-md border border-black/15 px-2 py-1 text-xs"
								/>
							</label>
							<button
								type="button"
								onClick={publish}
								disabled={busy}
								className="h-9 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
							>
								{busy
									? "Publishing…"
									: scheduledFor
										? "Schedule"
										: "Publish now"}
							</button>
							{msg && (
								<span
									className={`text-sm ${
										msg.includes("✓")
											? "text-green-600"
											: busy ||
													msg.includes("ublishing") ||
													msg.includes("cheduling")
												? "opacity-60"
												: "text-red-600"
									}`}
								>
									{msg}
								</span>
							)}
						</div>

						{results.length > 0 && (
							<div className="flex flex-wrap gap-2 text-xs">
								{results.map((p) => {
									const cls =
										p.status === "publishing"
											? "bg-black/10 text-black/60"
											: p.status === "failed"
												? "bg-red-100 text-red-700"
												: "bg-green-100 text-green-700";
									const mark =
										p.status === "publishing"
											? "…"
											: p.status === "failed"
												? "✗"
												: p.status === "scheduled"
													? "⏱"
													: "✓";
									return (
										<span
											key={p.platform}
											className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 ${cls}`}
											title={p.error}
										>
											{p.platform} {mark}
											{p.url && (
												<a
													href={p.url}
													target="_blank"
													rel="noopener noreferrer"
													className="underline hover:no-underline"
												>
													View ↗
												</a>
											)}
										</span>
									);
								})}
							</div>
						)}
					</div>
				)}
			</div>
		</div>
	);
}
