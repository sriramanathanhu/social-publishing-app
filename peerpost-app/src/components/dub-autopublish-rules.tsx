"use client";

import { useEffect, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";
import { DUB_LANGUAGES } from "@/lib/dub-options";

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

type Rule = {
	accountIds: string[];
	bufferMinutes: number;
	gapMinutes: number;
};

/**
 * Configure, per ecosystem, which connected accounts a dub of each target
 * language auto-schedules to when it finishes. Set once; opted-in dubs route by
 * it. Collapsed by default so it doesn't clutter the dub page.
 */
export function DubAutopublishRules({
	ecosystems,
	enabled: initialEnabled,
}: {
	ecosystems: Ecosystem[];
	enabled: boolean;
}) {
	const [open, setOpen] = useState(false);
	const [enabled, setEnabled] = useState(initialEnabled);
	const [ecoId, setEcoId] = useState(ecosystems[0]?.id ?? "");
	const [rules, setRules] = useState<Record<string, Rule>>({});
	const [adding, setAdding] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	async function setGlobal(on: boolean) {
		setEnabled(on); // optimistic
		try {
			const res = await fetch("/api/dub/autopublish-enabled", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ enabled: on }),
			});
			if (!res.ok) setEnabled(!on);
		} catch {
			setEnabled(!on);
		}
	}

	const eco = ecosystems.find((e) => e.id === ecoId);
	const accounts = (eco?.accounts ?? []).filter((a) =>
		VIDEO_PLATFORMS.has(a.platform),
	);
	const langLabel = (code: string) =>
		DUB_LANGUAGES.find((l) => l.code === code)?.label ?? code;

	// Load existing rules when the ecosystem changes (only while open).
	useEffect(() => {
		if (!open || !ecoId) return;
		setMsg(null);
		fetch(`/api/dub/autopublish-rules?profileId=${ecoId}`)
			.then((r) => r.json())
			.then((d) => {
				const next: Record<string, Rule> = {};
				for (const r of d.rules ?? [])
					next[r.lang] = {
						accountIds: r.accountIds ?? [],
						bufferMinutes: r.bufferMinutes ?? 30,
						gapMinutes: r.gapMinutes ?? 0,
					};
				setRules(next);
			})
			.catch(() => setRules({}));
	}, [open, ecoId]);

	function toggleAccount(lang: string, accountId: string) {
		setRules((prev) => {
			const r = prev[lang] ?? {
				accountIds: [],
				bufferMinutes: 30,
				gapMinutes: 0,
			};
			const has = r.accountIds.includes(accountId);
			return {
				...prev,
				[lang]: {
					...r,
					accountIds: has
						? r.accountIds.filter((id) => id !== accountId)
						: [...r.accountIds, accountId],
				},
			};
		});
	}

	async function saveRule(lang: string) {
		const r = rules[lang] ?? {
			accountIds: [],
			bufferMinutes: 30,
			gapMinutes: 0,
		};
		setBusy(true);
		setMsg(null);
		try {
			const res = await fetch("/api/dub/autopublish-rules", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					profileId: ecoId,
					lang,
					accountIds: r.accountIds,
					bufferMinutes: r.bufferMinutes,
					gapMinutes: r.gapMinutes,
				}),
			});
			if (!res.ok) throw new Error((await res.json()).error ?? "Save failed");
			setMsg(`Saved ${langLabel(lang)} rule.`);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Save failed");
		} finally {
			setBusy(false);
		}
	}

	function removeRule(lang: string) {
		setRules((prev) => {
			const next = { ...prev };
			delete next[lang];
			return next;
		});
		// Persist removal (empty accountIds deletes the rule).
		fetch("/api/dub/autopublish-rules", {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ profileId: ecoId, lang, accountIds: [] }),
		}).catch(() => {});
	}

	const configured = Object.keys(rules);

	return (
		<div className="rounded-lg border border-black/10 bg-black/[0.015] p-3">
			<button
				type="button"
				onClick={() => setOpen((o) => !o)}
				className="flex w-full items-center justify-between text-sm font-medium"
			>
				<span>⚙ Auto-publish rules (language → accounts)</span>
				<span className="opacity-50">{open ? "▾" : "▸"}</span>
			</button>
			{open && (
				<div className="mt-3 space-y-3 text-sm">
					<label className="flex items-center gap-2 rounded-md border border-black/10 bg-white p-2">
						<input
							type="checkbox"
							checked={enabled}
							onChange={(e) => setGlobal(e.target.checked)}
						/>
						<span className="font-medium">
							Auto-publish my dubs{" "}
							<span
								className={`ml-1 rounded px-1.5 py-0.5 text-[10px] ${enabled ? "bg-green-100 text-green-700" : "bg-black/10 opacity-60"}`}
							>
								{enabled ? "ON" : "OFF"}
							</span>
						</span>
						<span className="ml-auto text-xs opacity-50">global on/off</span>
					</label>
					<p className="text-xs opacity-60">
						While ON, every finished dub of yours is automatically scheduled to
						the accounts you map below for its language — no per-dub step. Turn
						it OFF to pause (your rules are kept). Use <b>Space each … apart</b>{" "}
						to stagger a batch (e.g. 120 min) so 10 dubs don’t all post at once.
					</p>
					<label className="block text-xs font-medium opacity-60">
						Ecosystem
						<select
							value={ecoId}
							onChange={(e) => setEcoId(e.target.value)}
							className="mt-1 block rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
						>
							{ecosystems.map((e) => (
								<option key={e.id} value={e.id}>
									{e.teamName} › {e.name}
								</option>
							))}
						</select>
					</label>

					{accounts.length === 0 ? (
						<p className="text-xs opacity-50">
							No video-capable accounts connected in this ecosystem.
						</p>
					) : (
						<>
							{configured.map((lang) => (
								<div
									key={lang}
									className="rounded-md border border-black/10 bg-white p-2"
								>
									<div className="mb-1 flex items-center justify-between">
										<span className="font-medium">{langLabel(lang)}</span>
										<button
											type="button"
											onClick={() => removeRule(lang)}
											className="text-[11px] text-red-600 hover:underline"
										>
											Remove
										</button>
									</div>
									<div className="flex flex-wrap gap-1.5">
										{accounts.map((a) => {
											const on =
												rules[lang]?.accountIds.includes(a.accountId) ?? false;
											return (
												<button
													type="button"
													key={a.accountId}
													onClick={() => toggleAccount(lang, a.accountId)}
													className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary bg-primary text-white" : "border-black/15 hover:bg-black/5"}`}
												>
													{a.platform}
													{a.handle ? ` · ${a.handle}` : ""}
												</button>
											);
										})}
									</div>
									<div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
										<label className="flex items-center gap-1 opacity-70">
											First post
											<input
												type="number"
												min={0}
												max={10080}
												value={rules[lang]?.bufferMinutes ?? 30}
												onChange={(e) =>
													setRules((prev) => ({
														...prev,
														[lang]: {
															accountIds: prev[lang]?.accountIds ?? [],
															gapMinutes: prev[lang]?.gapMinutes ?? 0,
															bufferMinutes: Number(e.target.value) || 0,
														},
													}))
												}
												className="w-16 rounded border border-black/15 px-1.5 py-0.5"
											/>
											min after dub
										</label>
										<label className="flex items-center gap-1 opacity-70">
											Space each
											<input
												type="number"
												min={0}
												max={10080}
												value={rules[lang]?.gapMinutes ?? 0}
												onChange={(e) =>
													setRules((prev) => ({
														...prev,
														[lang]: {
															accountIds: prev[lang]?.accountIds ?? [],
															bufferMinutes: prev[lang]?.bufferMinutes ?? 30,
															gapMinutes: Number(e.target.value) || 0,
														},
													}))
												}
												className="w-16 rounded border border-black/15 px-1.5 py-0.5"
											/>
											min apart
										</label>
										<button
											type="button"
											onClick={() => saveRule(lang)}
											disabled={busy}
											className="ml-auto rounded-md bg-primary px-2.5 py-1 font-medium text-white disabled:opacity-50"
										>
											Save
										</button>
									</div>
								</div>
							))}

							<div className="flex items-center gap-2">
								<select
									value={adding}
									onChange={(e) => {
										const l = e.target.value;
										if (l && !rules[l])
											setRules((prev) => ({
												...prev,
												[l]: {
													accountIds: [],
													bufferMinutes: 30,
													gapMinutes: 0,
												},
											}));
										setAdding("");
									}}
									className="rounded-md border border-black/15 px-2.5 py-1.5 text-sm"
								>
									<option value="">+ Add a language rule…</option>
									{DUB_LANGUAGES.filter((l) => !rules[l.code]).map((l) => (
										<option key={l.code} value={l.code}>
											{l.label}
										</option>
									))}
								</select>
								{msg && <span className="text-xs opacity-70">{msg}</span>}
							</div>
						</>
					)}
				</div>
			)}
		</div>
	);
}
