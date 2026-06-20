"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ZernioGroup = { externalId: string; name: string; count: number };

/**
 * Admin control: link a Zernio account GROUP to this ecosystem and import its
 * accounts (kept with their own profile ids, so a group spanning profiles
 * publishes correctly). Searchable; lazy-loads groups on first open.
 */
export function LinkZernioGroup({ ecosystemId }: { ecosystemId: string }) {
	const router = useRouter();
	const [groups, setGroups] = useState<ZernioGroup[] | null>(null);
	const [open, setOpen] = useState(false);
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [query, setQuery] = useState("");

	async function load() {
		setOpen(true);
		if (groups) return;
		setBusy(true);
		try {
			const res = await fetch("/api/admin/zernio/groups");
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Failed to load Zernio groups");
			setGroups(d.groups ?? []);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	async function link(groupId: string) {
		setBusy(true);
		setMsg(null);
		try {
			const res = await fetch(
				`/api/profiles/${ecosystemId}/import-zernio-group`,
				{
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ groupId }),
				},
			);
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
				Link Zernio group
			</button>
		);
	}

	const q = query.trim().toLowerCase();
	const matches = (groups ?? []).filter((g) =>
		q ? g.name.toLowerCase().includes(q) : true,
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
					placeholder={busy && !groups ? "Loading…" : "Search Zernio group…"}
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

			{groups && (
				<div className="max-h-56 overflow-y-auto rounded border border-black/10">
					{shown.length === 0 ? (
						<div className="px-2 py-1.5 text-[11px] opacity-50">No matches</div>
					) : (
						shown.map((g) => (
							<button
								type="button"
								key={g.externalId}
								disabled={busy}
								onClick={() => link(g.externalId)}
								className="block w-full truncate px-2 py-1.5 text-left text-xs hover:bg-black/5 disabled:opacity-50"
								title={g.name}
							>
								{g.name} <span className="opacity-40">({g.count})</span>
							</button>
						))
					)}
				</div>
			)}
			{msg && <span className="text-[11px] opacity-60">{msg}</span>}
		</div>
	);
}
