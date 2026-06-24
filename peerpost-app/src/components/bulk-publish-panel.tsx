"use client";

import { useMemo, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";

const IMAGE_PLATFORMS = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"bluesky",
	"threads",
	"instagram",
	"pinterest",
	"reddit",
	"telegram",
	"discord",
	"whatsapp",
	"googlebusiness",
]);
const VIDEO_PLATFORMS = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"instagram",
	"youtube",
	"tiktok",
	"threads",
	"reddit",
	"telegram",
	"snapchat",
	"googlebusiness",
	"bluesky",
	"whatsapp",
]);

export type BulkItem = {
	id: string;
	mediaType: "image" | "video";
	url: string;
	caption: string;
	label?: string;
};

type Status = "publishing" | "published" | "scheduled" | "failed";

export function BulkPublishPanel({
	items,
	ecosystems,
	onClose,
}: {
	items: BulkItem[];
	ecosystems: Ecosystem[];
	onClose: () => void;
}) {
	const mediaType = items[0]?.mediaType ?? "image";
	const allow = mediaType === "video" ? VIDEO_PLATFORMS : IMAGE_PLATFORMS;

	const usable = useMemo(
		() =>
			ecosystems
				.map((e) => ({
					...e,
					accounts: e.accounts.filter((a) => allow.has(a.platform)),
				}))
				.filter((e) => e.accounts.length > 0),
		[ecosystems, allow],
	);

	const [ecoId, setEcoId] = useState(usable[0]?.id ?? "");
	const eco = usable.find((e) => e.id === ecoId) ?? null;
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [captions, setCaptions] = useState<Record<string, string>>(() =>
		Object.fromEntries(items.map((i) => [i.id, i.caption])),
	);
	const [shared, setShared] = useState("");
	const [when, setWhen] = useState("");
	const [every, setEvery] = useState(1);
	const [unit, setUnit] = useState<"hours" | "days">("days");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<Record<string, Status>>({});

	const chosen = eco?.accounts.filter((a) => selected.has(a.accountId)) ?? [];

	function applyShared() {
		if (!shared.trim()) return;
		setCaptions(Object.fromEntries(items.map((i) => [i.id, shared])));
	}

	async function publish() {
		if (!eco || chosen.length === 0) {
			setMsg("Pick an ecosystem and at least one account.");
			return;
		}
		setBusy(true);
		setMsg(null);
		const base = when ? new Date(when).getTime() : 0;
		const stepMs = every * (unit === "days" ? 86_400_000 : 3_600_000);
		const targets = chosen.map((a) => ({
			platform: a.platform,
			accountId: a.accountId,
		}));

		let ok = 0;
		let fail = 0;
		for (let i = 0; i < items.length; i++) {
			const it = items[i];
			setResults((r) => ({ ...r, [it.id]: "publishing" }));
			const scheduledFor = when
				? new Date(base + i * stepMs).toISOString()
				: undefined;
			try {
				const res = await fetch(`/api/profiles/${eco.id}/posts`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({
						content: captions[it.id] ?? "",
						platforms: targets,
						mediaItems: [{ type: it.mediaType, url: it.url }],
						publishNow: when ? undefined : true,
						scheduledFor,
						timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
						source: "composer",
					}),
				});
				if (!res.ok) throw new Error();
				ok++;
				setResults((r) => ({
					...r,
					[it.id]: when ? "scheduled" : "published",
				}));
			} catch {
				fail++;
				setResults((r) => ({ ...r, [it.id]: "failed" }));
			}
		}
		setMsg(
			`${ok} ${when ? "scheduled" : "published"}${fail ? ` · ${fail} failed` : ""}`,
		);
		setBusy(false);
	}

	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
			role="presentation"
		>
			<div
				className="flex max-h-[88vh] w-full max-w-3xl flex-col overflow-hidden rounded-xl bg-white shadow-xl"
				onClick={(e) => e.stopPropagation()}
				role="presentation"
			>
				<div className="flex items-center justify-between border-slate-200 border-b px-4 py-3">
					<h3 className="font-semibold text-slate-800 text-sm">
						Publish {items.length} {mediaType === "video" ? "video" : "image"}
						{items.length === 1 ? "" : "s"}
					</h3>
					<button
						type="button"
						onClick={onClose}
						className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50"
					>
						Close
					</button>
				</div>

				<div className="space-y-4 overflow-y-auto p-4">
					{usable.length === 0 ? (
						<p className="text-slate-500 text-sm">
							No connected accounts support {mediaType} posts. Connect one under
							Connected Accounts.
						</p>
					) : (
						<>
							<div className="flex flex-wrap items-center gap-3">
								<select
									value={ecoId}
									onChange={(e) => {
										setEcoId(e.target.value);
										setSelected(new Set());
									}}
									className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
								>
									{usable.map((e) => (
										<option key={e.id} value={e.id}>
											{e.teamName} › {e.name}
										</option>
									))}
								</select>
								{eco?.accounts.map((a) => (
									<label
										key={a.accountId}
										className="flex items-center gap-1.5 text-slate-700 text-sm"
									>
										<input
											type="checkbox"
											checked={selected.has(a.accountId)}
											onChange={() =>
												setSelected((p) => {
													const n = new Set(p);
													n.has(a.accountId)
														? n.delete(a.accountId)
														: n.add(a.accountId);
													return n;
												})
											}
										/>
										{a.platform}
										{a.handle ? ` @${a.handle}` : ""}
									</label>
								))}
							</div>

							<div className="flex items-end gap-2">
								<label className="flex-1 text-xs">
									<span className="mb-1 block text-slate-500">
										Shared caption (apply to all)
									</span>
									<textarea
										value={shared}
										onChange={(e) => setShared(e.target.value)}
										rows={2}
										className="w-full resize-y rounded-lg border border-slate-300 p-2 text-sm"
									/>
								</label>
								<button
									type="button"
									onClick={applyShared}
									className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50"
								>
									Apply to all
								</button>
							</div>

							<div className="space-y-2">
								{items.map((it) => (
									<div
										key={it.id}
										className="flex gap-2 rounded-lg border border-slate-200 p-2"
									>
										{it.mediaType === "video" ? (
											// biome-ignore lint/a11y/useMediaCaption: preview
											<video
												src={it.url}
												className="h-16 w-12 shrink-0 rounded bg-black object-cover"
											/>
										) : (
											// biome-ignore lint/performance/noImgElement: preview
											<img
												src={it.url}
												alt=""
												className="h-16 w-12 shrink-0 rounded object-cover"
											/>
										)}
										<textarea
											value={captions[it.id] ?? ""}
											onChange={(e) =>
												setCaptions((c) => ({ ...c, [it.id]: e.target.value }))
											}
											rows={2}
											placeholder="Caption…"
											className="min-w-0 flex-1 resize-y rounded-md border border-slate-300 p-2 text-sm"
										/>
										{results[it.id] && (
											<span
												className={`self-center text-xs ${
													results[it.id] === "failed"
														? "text-red-600"
														: results[it.id] === "publishing"
															? "text-slate-400"
															: "text-green-600"
												}`}
											>
												{results[it.id]}
											</span>
										)}
									</div>
								))}
							</div>
						</>
					)}
				</div>

				<div className="flex flex-wrap items-center gap-3 border-slate-200 border-t px-4 py-3">
					<label className="flex items-center gap-2 text-slate-600 text-sm">
						<span className="whitespace-nowrap">Schedule for</span>
						<input
							type="datetime-local"
							value={when}
							onChange={(e) => setWhen(e.target.value)}
							className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
							title="Leave empty to publish now"
						/>
					</label>
					{when && (
						<span className="flex items-center gap-1 text-slate-500 text-xs">
							every
							<input
								type="number"
								min={1}
								value={every}
								onChange={(e) =>
									setEvery(Math.max(1, Number(e.target.value) || 1))
								}
								className="w-14 rounded border border-slate-300 px-1.5 py-1"
							/>
							<select
								value={unit}
								onChange={(e) => setUnit(e.target.value as "hours" | "days")}
								className="rounded border border-slate-300 px-1.5 py-1"
							>
								<option value="hours">hours</option>
								<option value="days">days</option>
							</select>
						</span>
					)}
					<button
						type="button"
						onClick={publish}
						disabled={busy || chosen.length === 0}
						className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40"
					>
						{busy ? "Working…" : when ? "Schedule all" : "Publish all now"}
					</button>
					{msg && <span className="text-slate-600 text-sm">{msg}</span>}
				</div>
			</div>
		</div>
	);
}
