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

	return (
		<div className="flex flex-col gap-1">
			<select
				disabled={busy}
				defaultValue=""
				onChange={(e) => e.target.value && link(e.target.value)}
				className="max-w-[200px] rounded border border-black/15 px-2 py-1 text-xs"
			>
				<option value="">{busy ? "Working…" : "Select Zernio profile…"}</option>
				{profiles?.map((p) => (
					<option key={p.externalId} value={p.externalId}>
						{p.name}
					</option>
				))}
			</select>
			{msg && <span className="text-[11px] opacity-60">{msg}</span>}
		</div>
	);
}
