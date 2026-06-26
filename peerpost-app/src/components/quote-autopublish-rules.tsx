"use client";

import { useEffect, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";

// Quote cards are images — every platform that accepts an image post. (Video-only
// surfaces like YouTube and TikTok are excluded.)
const IMAGE_PLATFORMS = new Set([
	"twitter",
	"linkedin",
	"facebook",
	"instagram",
	"threads",
	"reddit",
	"telegram",
	"snapchat",
	"googlebusiness",
	"bluesky",
	"whatsapp",
	"pinterest",
]);

// The output-language labels the Quote studio can generate (card fonts exist for
// all of these). Kept in sync with quote-studio's LANGUAGES.
const QUOTE_LANGUAGES = [
	"English",
	"Hindi",
	"Tamil",
	"Telugu",
	"Kannada",
	"Malayalam",
	"Swahili",
	"Gujarati",
	"Marathi",
	"Bhojpuri",
	"Punjabi",
	"Russian",
	"Spanish",
	"French",
	"Dutch",
	"Korean",
	"Portuguese",
];

type Rule = {
	accountIds: string[];
	bufferMinutes: number;
	gapMinutes: number;
};

/**
 * Per ecosystem, map each quote output-language to the image-capable accounts a
 * card of that language is scheduled to (with a first-post delay + drip gap).
 * The "Generate & auto-schedule" button in the studio routes by these rules.
 * Separate from the dub rules so quotes can target different channels.
 */
export function QuoteAutopublishRules({
	ecosystems,
}: {
	readonly ecosystems: Ecosystem[];
}) {
	const [open, setOpen] = useState(false);
	const [ecoId, setEcoId] = useState(ecosystems[0]?.id ?? "");
	const [rules, setRules] = useState<Record<string, Rule>>({});
	const [adding, setAdding] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	const eco = ecosystems.find((e) => e.id === ecoId);
	const accounts = (eco?.accounts ?? []).filter((a) =>
		IMAGE_PLATFORMS.has(a.platform),
	);

	// Load existing rules when the ecosystem changes (only while open).
	useEffect(() => {
		if (!open || !ecoId) return;
		setMsg(null);
		fetch(`/api/quotes/autopublish-rules?profileId=${ecoId}`)
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
			const res = await fetch("/api/quotes/autopublish-rules", {
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
			setMsg(`Saved ${lang} rule.`);
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
		fetch("/api/quotes/autopublish-rules", {
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
				<span>⚙ Quote auto-publish rules (language → accounts)</span>
				<span className="opacity-50">{open ? "▾" : "▸"}</span>
			</button>
			{open && (
				<div className="mt-3 space-y-3 text-sm">
					<p className="text-xs opacity-60">
						Map each language to the accounts its quote cards should post to.
						“Generate &amp; auto-schedule” then renders cards and schedules each
						language to these accounts — first one <b>{"<first post>"}</b> min
						out, then one every <b>{"<gap>"}</b> min.
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
							No image-capable accounts connected in this ecosystem.
						</p>
					) : (
						<>
							{configured.map((lang) => (
								<div
									key={lang}
									className="rounded-md border border-black/10 bg-white p-2"
								>
									<div className="mb-1 flex items-center justify-between">
										<span className="font-medium">{lang}</span>
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
											min out
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
									{QUOTE_LANGUAGES.filter((l) => !rules[l]).map((l) => (
										<option key={l} value={l}>
											{l}
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
