"use client";

import { useCallback, useEffect, useState } from "react";

/**
 * After a piece is generated, translate it into the languages you pick and
 * schedule each translation to that language's mapped accounts (per the kind's
 * rules). Shows only the languages you've configured a rule for.
 */
export function TextAutoSchedule({
	kind,
	itemId,
}: {
	readonly kind: "article" | "transcript";
	readonly itemId: string | null;
}) {
	const [langs, setLangs] = useState<string[]>([]);
	const [picked, setPicked] = useState<Set<string>>(new Set());
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	const load = useCallback(() => {
		fetch(`/api/text/autopublish-rules?kind=${kind}&languages=1`)
			.then((r) => r.json())
			.then((d) => setLangs(d.languages ?? []))
			.catch(() => setLangs([]));
	}, [kind]);

	useEffect(() => {
		load();
		const evt = `text:${kind}:rules-changed`;
		window.addEventListener(evt, load);
		window.addEventListener("focus", load);
		return () => {
			window.removeEventListener(evt, load);
			window.removeEventListener("focus", load);
		};
	}, [load, kind]);

	function toggle(l: string) {
		setPicked((p) => {
			const n = new Set(p);
			if (n.has(l)) n.delete(l);
			else n.add(l);
			return n;
		});
	}

	async function run() {
		if (!itemId) {
			setMsg("Generate or select a piece first.");
			return;
		}
		if (picked.size === 0) {
			setMsg("Pick at least one language.");
			return;
		}
		setBusy(true);
		setMsg(null);
		try {
			const res = await fetch("/api/text/auto-publish", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ kind, itemId, languages: [...picked] }),
			});
			const d = await res.json().catch(() => ({}));
			if (!res.ok) throw new Error(d.error ?? "Failed");
			if (d.error) {
				setMsg(d.error);
				return;
			}
			setMsg(
				`Translated + scheduled ${d.scheduled} post(s) across ${d.languages} language(s)${
					d.failed ? ` · ${d.failed} failed` : ""
				}. See Scheduled.`,
			);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	if (langs.length === 0) return null;

	return (
		<div className="space-y-2 rounded-lg border border-primary/30 bg-primary/[0.03] p-3">
			<div className="text-sm font-medium">
				⚡ Translate &amp; auto-schedule
			</div>
			<p className="text-xs opacity-60">
				Pick languages — this {kind} is translated into each and scheduled to
				its mapped accounts.
			</p>
			<div className="flex flex-wrap gap-1.5">
				{langs.map((l) => {
					const on = picked.has(l);
					return (
						<button
							type="button"
							key={l}
							onClick={() => toggle(l)}
							className={`rounded-full border px-2.5 py-1 text-xs ${on ? "border-primary bg-primary text-white" : "border-black/15 hover:bg-black/5"}`}
						>
							{l}
						</button>
					);
				})}
			</div>
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={run}
					disabled={busy || !itemId || picked.size === 0}
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy
						? "Translating & scheduling…"
						: `Translate & schedule (${picked.size})`}
				</button>
				{msg && <span className="text-xs opacity-70">{msg}</span>}
			</div>
		</div>
	);
}
