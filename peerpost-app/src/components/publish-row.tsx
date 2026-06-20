"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export type Provider = "postpeer" | "zernio";
export type EcoAccount = {
	platform: string;
	accountId: string;
	handle: string | null;
	provider?: Provider;
};
export type Ecosystem = {
	id: string;
	name: string;
	teamName: string;
	accounts: EcoAccount[];
};
type RowResult = {
	platform: string;
	status: "publishing" | "published" | "scheduled" | "failed";
	error?: string;
};

const PROVIDER_LABEL: Record<Provider, string> = {
	postpeer: "PostPeer",
	zernio: "Zernio",
};

/**
 * Parse a fetch Response as JSON, but if the body is HTML (a proxy timeout /
 * error page — common when publishing a large video through the gateway),
 * throw a readable error with the status instead of the cryptic
 * "Unexpected token '<'". Returns the parsed object; the caller still checks
 * res.ok to read per-platform results from a JSON 4xx.
 */
export async function readJson(res: Response): Promise<{
	error?: string;
	publicUrl?: string;
	platforms?: { platform: string; success: boolean; error?: string }[];
	scheduled?: boolean;
	jobs?: { id: string; platform: string; accountId: string }[];
	statuses?: { id: string; status: string; error?: string | null }[];
}> {
	const text = await res.text();
	try {
		return text ? JSON.parse(text) : {};
	} catch {
		const gateway = res.status >= 502 && res.status <= 524;
		throw new Error(
			gateway
				? `Publish timed out at the gateway (${res.status}). The video may be too large or slow to process — try again, or a shorter clip.`
				: `Server returned a non-JSON response (${res.status}).`,
		);
	}
}

/**
 * One publishable media row: a preview, editable title + caption, and an inline
 * mini-composer (ecosystem → accounts → provider toggle → optional schedule →
 * publish), with per-platform results. `prepareMedia` returns the provider-ready
 * media URL (dub: export to PostPeer; shorts: re-host the R2 clip).
 */
export function PublishRow({
	previewUrl,
	meta,
	initialTitle,
	initialCaption,
	ecosystems,
	prepareMedia,
}: {
	previewUrl: string | null;
	meta?: string;
	initialTitle: string;
	initialCaption: string;
	ecosystems: Ecosystem[];
	prepareMedia: () => Promise<string>;
}) {
	const router = useRouter();
	const [title, setTitle] = useState(initialTitle);
	const [caption, setCaption] = useState(initialCaption);
	const [ecoId, setEcoId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [provider, setProvider] = useState<Provider>("postpeer");
	const [scheduledFor, setScheduledFor] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<RowResult[]>([]);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const providers = Array.from(
		new Set((eco?.accounts ?? []).map((a) => a.provider ?? "postpeer")),
	) as Provider[];
	const showProviderToggle = providers.length > 1;
	const visibleAccounts = (eco?.accounts ?? []).filter((a) =>
		showProviderToggle ? (a.provider ?? "postpeer") === provider : true,
	);

	function toggle(accountId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(accountId) ? next.delete(accountId) : next.add(accountId);
			return next;
		});
	}

	function pickEco(id: string) {
		setEcoId(id);
		setSelected(new Set());
		setResults([]);
		setMsg(null);
		const e = ecosystems.find((x) => x.id === id);
		const provs = Array.from(
			new Set((e?.accounts ?? []).map((a) => a.provider ?? "postpeer")),
		) as Provider[];
		setProvider(
			provs.includes("postpeer") ? "postpeer" : (provs[0] ?? "postpeer"),
		);
	}

	async function publish() {
		const targets = visibleAccounts
			.filter((a) => selected.has(a.accountId))
			.map((a) => ({
				platform: a.platform,
				accountId: a.accountId,
				platformSpecificData:
					a.platform === "youtube" && title ? { title } : undefined,
			}));
		if (targets.length === 0) {
			setMsg("Select at least one account.");
			return;
		}
		setBusy(true);
		setMsg(null);
		setResults([]);
		let jobs: { id: string; platform: string }[] = [];
		try {
			const mediaUrl = await prepareMedia();
			const res = await fetch(`/api/profiles/${ecoId}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: caption,
					platforms: targets,
					mediaItems: [{ type: "video", url: mediaUrl }],
					publishNow: scheduledFor ? undefined : true,
					scheduledFor: scheduledFor
						? new Date(scheduledFor).toISOString()
						: undefined,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
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
		// Queued — publishing now runs in the background; poll each account's
		// status so a slow platform never times out the request. Stays "busy".
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
					};
				});
				setResults(updated);
				const pending = updated.some((u) => u.status === "publishing");
				if (pending && Date.now() - started < 180_000) {
					setTimeout(tick, 3000);
					return;
				}
				const failed = updated.filter((u) => u.status === "failed").length;
				const stillGoing = updated.filter(
					(u) => u.status === "publishing",
				).length;
				const verb = sched ? "Scheduled" : "Published";
				setMsg(
					stillGoing
						? "Still publishing — check back shortly"
						: failed
							? `${verb} — ${failed} account(s) failed`
							: `${verb} ✓`,
				);
				setBusy(false);
				router.refresh();
			} catch {
				// Transient — keep polling for a bit.
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
			<div className="grid items-start gap-3 md:grid-cols-[96px_1fr_1.5fr_220px]">
				{/* Preview */}
				<div>
					{previewUrl ? (
						// biome-ignore lint/a11y/useMediaCaption: user-generated clip, no captions track
						<video
							src={previewUrl}
							controls
							preload="metadata"
							className="aspect-[9/16] w-full rounded-lg bg-black/5 object-cover"
						/>
					) : (
						<div className="flex aspect-[9/16] w-full items-center justify-center rounded-lg bg-black/5 text-xs opacity-40">
							…
						</div>
					)}
					{meta && (
						<div className="mt-1 text-center text-[11px] opacity-50">
							{meta}
						</div>
					)}
				</div>

				{/* Title */}
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					placeholder="Title"
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
				/>

				{/* Caption */}
				<textarea
					value={caption}
					onChange={(e) => setCaption(e.target.value)}
					rows={4}
					placeholder="Description / caption"
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
				/>

				{/* Publish to */}
				<select
					value={ecoId}
					onChange={(e) => pickEco(e.target.value)}
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
				>
					<option value="">Choose ecosystem…</option>
					{ecosystems.map((e) => (
						<option key={e.id} value={e.id}>
							{e.teamName} › {e.name} ({e.accounts.length})
						</option>
					))}
				</select>
			</div>

			{eco && (
				<div className="mt-3 space-y-2 border-t border-black/5 pt-3">
					{showProviderToggle && (
						<div className="flex items-center gap-1 text-xs">
							<span className="opacity-50">Publish via:</span>
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
						<p className="text-xs opacity-50">No connected accounts here.</p>
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
							{busy ? "Publishing…" : scheduledFor ? "Schedule" : "Publish now"}
						</button>
						{msg && (
							<span
								className={`text-sm ${
									msg.includes("✓")
										? "text-green-600"
										: busy ||
												msg.includes("publishing") ||
												msg.includes("Publishing")
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
										className={`rounded px-1.5 py-0.5 ${cls}`}
										title={p.error}
									>
										{p.platform} {mark}
									</span>
								);
							})}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
