"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ZernioProfile = { externalId: string; name: string };

/**
 * Admin control: link a Zernio profile to this ecosystem and import its
 * accounts. Lazy-loads the Zernio profile list on first open to avoid a
 * provider call for every row on page load.
 */
export function LinkZernio({ ecosystemId }: { ecosystemId: string }) {
	const router = useRouter();
	const [profiles, setProfiles] = useState<ZernioProfile[] | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [query, setQuery] = useState("");

	async function load() {
		setOpen(true);
		if (profiles) return;
		setBusy(true);
		try {
			const res = await fetch("/api/admin/zernio/profiles");
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Failed to load Zernio profiles");
			setProfiles(d.profiles ?? []);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	async function link(externalProfileId: string) {
		setBusy(true);
		setMsg(null);
		try {
			const res = await fetch(`/api/profiles/${ecosystemId}/import-zernio`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ externalProfileId }),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Import failed");
			setMsg(`Imported ${d.imported} accounts`);
			setOpen(false);
			router.refresh();
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	if (!open) {
		return (
			<button
				type="button"
				onClick={load}
				className="text-xs text-primary hover:underline"
			>
				Link Zernio
			</button>
		);
	}

	const q = query.trim().toLowerCase();
	const matches = (profiles ?? []).filter((p) =>
		q ? p.name.toLowerCase().includes(q) : true,
	);
	const shown = matches.slice(0, 50);

	return (
		<div className="flex w-[240px] flex-col gap-1">
			<div className="flex items-center gap-1">
				{/** biome-ignore lint/a11y/noAutofocus: opened on demand by the user */}
				<input
					autoFocus
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					disabled={busy}
					placeholder={
						busy && !profiles ? "Loading…" : "Search Zernio profile…"
					}
					className="w-full rounded border border-black/15 px-2 py-1 text-xs"
				/>
				<button
					type="button"
					onClick={() => {
						setOpen(false);
						setQuery("");
					}}
					className="px-1 text-xs opacity-50 hover:opacity-100"
					title="Cancel"
				>
					✕
				</button>
			</div>

			{profiles && (
				<div className="max-h-56 overflow-y-auto rounded border border-black/10">
					{shown.length === 0 ? (
						<div className="px-2 py-1.5 text-[11px] opacity-50">No matches</div>
					) : (
						shown.map((p) => (
							<button
								type="button"
								key={p.externalId}
								disabled={busy}
								onClick={() => link(p.externalId)}
								className="block w-full truncate px-2 py-1.5 text-left text-xs hover:bg-black/5 disabled:opacity-50"
								title={p.name}
							>
								{p.name}
							</button>
						))
					)}
					{matches.length > shown.length && (
						<div className="px-2 py-1 text-[11px] opacity-40">
							+{matches.length - shown.length} more — keep typing to narrow
						</div>
					)}
				</div>
			)}
			{msg && <span className="text-[11px] opacity-60">{msg}</span>}
		</div>
	);
}
