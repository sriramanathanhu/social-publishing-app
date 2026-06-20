"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Provider = "postpeer" | "zernio";
type EcoAccount = {
	platform: string;
	accountId: string;
	handle: string | null;
	provider?: Provider;
};
type Ecosystem = {
	id: string;
	name: string;
	teamName: string;
	accounts: EcoAccount[];
};
type DubRowData = {
	id: string;
	status: string;
	targetLang: string;
	createdAt: string;
	videoUrl: string | null;
	title: string;
	caption: string;
};
type PlatformResult = { platform: string; success: boolean; error?: string };

const PROVIDER_LABEL: Record<Provider, string> = {
	postpeer: "PostPeer",
	zernio: "Zernio",
};

export function DubTable({
	rows,
	ecosystems,
}: {
	rows: DubRowData[];
	ecosystems: Ecosystem[];
}) {
	if (rows.length === 0) {
		return (
			<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
				No dubs yet. Run a dub above and it will appear here to publish.
			</p>
		);
	}
	return (
		<div className="space-y-3">
			<h2 className="text-sm font-semibold opacity-70">Dubbed videos</h2>
			{/* Column headings (desktop). */}
			<div className="hidden gap-3 px-3 text-xs font-medium uppercase tracking-wide opacity-40 md:grid md:grid-cols-[90px_1fr_1.6fr_240px]">
				<div>Video</div>
				<div>Title</div>
				<div>Description / Caption</div>
				<div>Publish to</div>
			</div>
			{rows.map((r) => (
				<DubRow key={r.id} row={r} ecosystems={ecosystems} />
			))}
		</div>
	);
}

function DubRow({
	row,
	ecosystems,
}: {
	row: DubRowData;
	ecosystems: Ecosystem[];
}) {
	const router = useRouter();
	const [title, setTitle] = useState(row.title);
	const [caption, setCaption] = useState(row.caption);
	const [ecoId, setEcoId] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [scheduledFor, setScheduledFor] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<PlatformResult[]>([]);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const providers = Array.from(
		new Set((eco?.accounts ?? []).map((a) => a.provider ?? "postpeer")),
	) as Provider[];
	const [provider, setProvider] = useState<Provider>("postpeer");
	const showProviderToggle = providers.length > 1;
	const visibleAccounts = (eco?.accounts ?? []).filter((a) =>
		showProviderToggle ? (a.provider ?? "postpeer") === provider : true,
	);

	const done = row.status === "done";

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
				// YouTube needs a title; pass the row's title for those accounts.
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
		try {
			// Host the dub where the providers can fetch it (PostPeer media);
			// idempotent — returns the cached URL if already exported.
			const ex = await fetch(`/api/dub/${row.id}/export`, { method: "POST" });
			const exd = await ex.json();
			if (!ex.ok) throw new Error(exd.error ?? "Couldn’t prepare the video");
			const mediaUrl: string = exd.publicUrl;

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
			const d = await res.json();
			setResults(d.platforms ?? []);
			if (!res.ok) throw new Error(d.error ?? "Publish failed");
			setMsg(scheduledFor ? "Scheduled ✓" : "Published ✓");
			router.refresh();
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="rounded-lg border border-black/10 p-3">
			<div className="grid items-start gap-3 md:grid-cols-[90px_1fr_1.6fr_240px]">
				{/* Video */}
				<div className="text-sm">
					{row.videoUrl ? (
						<a
							href={row.videoUrl}
							target="_blank"
							rel="noreferrer"
							className="text-primary hover:underline"
						>
							▶ Open
						</a>
					) : (
						<span className="opacity-40" title="Archiving…">
							—
						</span>
					)}
					<div className="text-[11px] uppercase opacity-40">
						{row.targetLang}
					</div>
				</div>

				{/* Title */}
				<input
					value={title}
					onChange={(e) => setTitle(e.target.value)}
					disabled={!done}
					placeholder="Title"
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm disabled:opacity-50"
				/>

				{/* Caption */}
				<textarea
					value={caption}
					onChange={(e) => setCaption(e.target.value)}
					disabled={!done}
					rows={3}
					placeholder="Description / caption"
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm disabled:opacity-50"
				/>

				{/* Publish to */}
				<div>
					{done ? (
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
					) : (
						<span
							className={`rounded px-1.5 py-0.5 text-xs ${
								row.status === "failed"
									? "bg-red-100 text-red-700"
									: "bg-blue-100 text-blue-700"
							}`}
						>
							{row.status}
						</span>
					)}
				</div>
			</div>

			{/* Expanded publish controls once an ecosystem is chosen. */}
			{done && eco && (
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
								className={`text-sm ${msg.includes("✓") ? "text-green-600" : "text-red-600"}`}
							>
								{msg}
							</span>
						)}
					</div>

					{results.length > 0 && (
						<div className="flex flex-wrap gap-2 text-xs">
							{results.map((p) => (
								<span
									key={p.platform}
									className={`rounded px-1.5 py-0.5 ${p.success ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700"}`}
									title={p.error}
								>
									{p.platform} {p.success ? "✓" : "✗"}
								</span>
							))}
						</div>
					)}
				</div>
			)}
		</div>
	);
}
