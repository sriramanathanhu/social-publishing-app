"use client";

import { useEffect, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";

// Shorts are videos — platforms that accept a video post.
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

export type ShortsDistribution = {
	id: string;
	name: string;
	shortsPerTarget: number;
	bufferMinutes: number;
	gapMinutes: number;
	targets: { profileId: string; accountId: string }[];
};

const key = (profileId: string, accountId: string) =>
	`${profileId}:${accountId}`;

type Draft = {
	id?: string;
	name: string;
	shortsPerTarget: number;
	bufferMinutes: number;
	gapMinutes: number;
	selected: Set<string>;
};

const blankDraft = (): Draft => ({
	name: "",
	shortsPerTarget: 10,
	bufferMinutes: 30,
	gapMinutes: 60,
	selected: new Set(),
});

/**
 * Manage reusable shorts "target lists": a named set of accounts spanning any
 * ecosystems. A shorts job opted into one spreads its finished clips so each
 * ECOSYSTEM gets a distinct slice, broadcast to its selected platforms.
 */
export function ShortsDistributions({
	ecosystems,
}: {
	readonly ecosystems: Ecosystem[];
}) {
	const [open, setOpen] = useState(false);
	const [lists, setLists] = useState<ShortsDistribution[]>([]);
	const [draft, setDraft] = useState<Draft | null>(null);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	async function load() {
		try {
			const d = await fetch("/api/shorts/distributions").then((r) => r.json());
			setLists(d.distributions ?? []);
		} catch {
			setLists([]);
		}
	}
	useEffect(() => {
		if (open) load();
	}, [open]);

	function editList(d: ShortsDistribution) {
		setDraft({
			id: d.id,
			name: d.name,
			shortsPerTarget: d.shortsPerTarget,
			bufferMinutes: d.bufferMinutes,
			gapMinutes: d.gapMinutes,
			selected: new Set(d.targets.map((t) => key(t.profileId, t.accountId))),
		});
		setMsg(null);
	}

	function toggle(profileId: string, accountId: string) {
		setDraft((p) => {
			if (!p) return p;
			const next = new Set(p.selected);
			const k = key(profileId, accountId);
			if (next.has(k)) next.delete(k);
			else next.add(k);
			return { ...p, selected: next };
		});
	}

	async function save() {
		if (!draft) return;
		if (!draft.name.trim()) {
			setMsg("Name the list.");
			return;
		}
		const targets = [...draft.selected].map((k) => {
			const [profileId, accountId] = k.split(":");
			return { profileId, accountId };
		});
		if (targets.length === 0) {
			setMsg("Pick at least one target account.");
			return;
		}
		setBusy(true);
		setMsg(null);
		try {
			const res = await fetch("/api/shorts/distributions", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					id: draft.id,
					name: draft.name,
					shortsPerTarget: draft.shortsPerTarget,
					bufferMinutes: draft.bufferMinutes,
					gapMinutes: draft.gapMinutes,
					targets,
				}),
			});
			if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
			setDraft(null);
			await load();
			window.dispatchEvent(new Event("shorts:distributions-changed"));
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Save failed");
		} finally {
			setBusy(false);
		}
	}

	async function remove(id: string) {
		await fetch(`/api/shorts/distributions/${id}`, { method: "DELETE" }).catch(
			() => {},
		);
		await load();
		window.dispatchEvent(new Event("shorts:distributions-changed"));
	}

	const selCount = draft?.selected.size ?? 0;
	const selEcos = draft
		? new Set([...draft.selected].map((k) => k.split(":")[0])).size
		: 0;

	return (
		<div className="rounded-lg border border-black/10 bg-black/[0.015] p-3">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between text-sm font-medium"
			>
				<span>⚙ Shorts target lists (spread clips across ecosystems)</span>
				<span className="opacity-50">{open ? "▾" : "▸"}</span>
			</button>
			{open && (
				<div className="mt-3 space-y-3 text-sm">
					<p className="text-xs opacity-60">
						A named set of accounts across any ecosystems. Attach a list when
						you start a shorts job — as clips finish, each <b>ecosystem</b> gets
						a distinct slice of <b>clips per ecosystem</b> (no repeats),
						broadcast to all its selected platforms, drip-spaced.
					</p>

					{!draft && (
						<>
							{lists.length === 0 ? (
								<p className="text-xs opacity-50">No lists yet.</p>
							) : (
								<div className="space-y-1.5">
									{lists.map((d) => {
										const ecos = new Set(d.targets.map((t) => t.profileId))
											.size;
										return (
											<div
												key={d.id}
												className="flex items-center justify-between rounded-md border border-black/10 bg-white px-2.5 py-1.5"
											>
												<div>
													<span className="font-medium">{d.name}</span>
													<span className="ml-2 text-xs opacity-50">
														{ecos} ecosystem{ecos === 1 ? "" : "s"} ·{" "}
														{d.targets.length} accounts · {d.shortsPerTarget}
														/ecosystem
													</span>
												</div>
												<div className="flex gap-2">
													<button
														type="button"
														onClick={() => editList(d)}
														className="text-[11px] text-primary hover:underline"
													>
														Edit
													</button>
													<button
														type="button"
														onClick={() => remove(d.id)}
														className="text-[11px] text-red-600 hover:underline"
													>
														Delete
													</button>
												</div>
											</div>
										);
									})}
								</div>
							)}
							<button
								type="button"
								onClick={() => setDraft(blankDraft())}
								className="rounded-md border border-black/15 px-2.5 py-1 text-xs hover:bg-black/5"
							>
								+ New target list
							</button>
						</>
					)}

					{draft && (
						<div className="space-y-3 rounded-md border border-primary/30 bg-primary/[0.03] p-3">
							<div className="flex flex-wrap items-end gap-3">
								<label className="text-xs font-medium opacity-60">
									Name
									<input
										value={draft.name}
										onChange={(e) =>
											setDraft({ ...draft, name: e.target.value })
										}
										placeholder="e.g. English channels"
										className="mt-1 block w-48 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
									/>
								</label>
								<label className="text-xs font-medium opacity-60">
									Clips / ecosystem
									<input
										type="number"
										min={1}
										max={100}
										value={draft.shortsPerTarget}
										onChange={(e) =>
											setDraft({
												...draft,
												shortsPerTarget: Number(e.target.value) || 1,
											})
										}
										className="mt-1 block w-20 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
									/>
								</label>
								<label className="text-xs font-medium opacity-60">
									First post (min)
									<input
										type="number"
										min={0}
										max={10080}
										value={draft.bufferMinutes}
										onChange={(e) =>
											setDraft({
												...draft,
												bufferMinutes: Number(e.target.value) || 0,
											})
										}
										className="mt-1 block w-20 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
									/>
								</label>
								<label className="text-xs font-medium opacity-60">
									Gap (min)
									<input
										type="number"
										min={0}
										max={10080}
										value={draft.gapMinutes}
										onChange={(e) =>
											setDraft({
												...draft,
												gapMinutes: Number(e.target.value) || 0,
											})
										}
										className="mt-1 block w-20 rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
									/>
								</label>
							</div>

							<div className="space-y-2">
								<div className="text-xs font-medium opacity-60">
									Target accounts ({selCount} selected across {selEcos}{" "}
									ecosystem
									{selEcos === 1 ? "" : "s"})
								</div>
								{ecosystems.map((eco) => {
									const accs = (eco.accounts ?? []).filter((a) =>
										VIDEO_PLATFORMS.has(a.platform),
									);
									if (accs.length === 0) return null;
									return (
										<div
											key={eco.id}
											className="rounded-md border border-black/10 bg-white p-2"
										>
											<div className="mb-1 text-xs font-medium opacity-70">
												{eco.teamName} › {eco.name}
											</div>
											<div className="flex flex-wrap gap-1.5">
												{accs.map((a) => {
													const on = draft.selected.has(
														key(eco.id, a.accountId),
													);
													return (
														<button
															type="button"
															key={a.accountId}
															onClick={() => toggle(eco.id, a.accountId)}
															className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary bg-primary text-white" : "border-black/15 hover:bg-black/5"}`}
														>
															{a.platform}
															{a.handle ? ` · ${a.handle}` : ""}
														</button>
													);
												})}
											</div>
										</div>
									);
								})}
							</div>

							<div className="flex items-center gap-2">
								<button
									type="button"
									onClick={save}
									disabled={busy}
									className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
								>
									{busy ? "Saving…" : "Save list"}
								</button>
								<button
									type="button"
									onClick={() => setDraft(null)}
									className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5"
								>
									Cancel
								</button>
								{msg && <span className="text-xs opacity-70">{msg}</span>}
							</div>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
