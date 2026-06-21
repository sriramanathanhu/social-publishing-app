"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Team = { id: string; name: string };

/**
 * Admin control: move an ecosystem to a different team. PATCHes teamId and
 * refreshes; reverts the selection on error.
 */
export function TeamSelect({
	ecosystemId,
	teamId,
	teams,
}: {
	readonly ecosystemId: string;
	readonly teamId: string | null;
	readonly teams: readonly Team[];
}) {
	const router = useRouter();
	const [value, setValue] = useState(teamId ?? "");
	const [busy, setBusy] = useState(false);

	async function change(next: string) {
		const prev = value;
		setValue(next);
		setBusy(true);
		try {
			const r = await fetch(`/api/profiles/${ecosystemId}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ teamId: next }),
			});
			if (!r.ok) {
				const d = await r.json().catch(() => ({}));
				throw new Error(d.error ?? "Failed to move team");
			}
			router.refresh();
		} catch (err) {
			setValue(prev);
			window.alert(err instanceof Error ? err.message : "Failed to move team");
		} finally {
			setBusy(false);
		}
	}

	return (
		<select
			value={value}
			disabled={busy}
			onChange={(e) => change(e.target.value)}
			className="rounded-md border border-black/15 px-2 py-1 text-xs disabled:opacity-50"
		>
			{teams.map((t) => (
				<option key={t.id} value={t.id}>
					{t.name}
				</option>
			))}
		</select>
	);
}
