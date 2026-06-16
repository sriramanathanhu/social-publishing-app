"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type Account = {
	accountId: string;
	handle: string | null;
	displayName: string | null;
	active: boolean;
};

/**
 * Bulk "which accounts are usable" manager for one platform. Connecting imports
 * every page (up to hundreds); here the user searches and selects only the ones
 * they want active. Saving marks those active and ALL others inactive in one
 * call — non-destructive, so reconnecting never undoes the choice.
 */
export function ManageAccounts({
	profileId,
	platform,
	label,
	accounts,
	onClose,
}: {
	profileId: string;
	platform: string;
	label: string;
	accounts: Account[];
	onClose: () => void;
}) {
	const router = useRouter();
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(
		new Set(accounts.filter((a) => a.active).map((a) => a.accountId)),
	);
	const [busy, setBusy] = useState(false);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return accounts;
		return accounts.filter(
			(a) =>
				(a.handle ?? "").toLowerCase().includes(q) ||
				(a.displayName ?? "").toLowerCase().includes(q),
		);
	}, [accounts, query]);

	function toggle(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	}
	function setMany(ids: string[], on: boolean) {
		setSelected((prev) => {
			const next = new Set(prev);
			for (const id of ids) on ? next.add(id) : next.delete(id);
			return next;
		});
	}

	async function save() {
		setBusy(true);
		try {
			await fetch(`/api/profiles/${profileId}/integrations/active`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ platform, activeAccountIds: [...selected] }),
			});
			onClose();
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	const filteredIds = filtered.map((a) => a.accountId);

	return (
		<div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4">
			<div className="flex max-h-[80vh] w-full max-w-lg flex-col rounded-xl bg-white p-4 shadow-xl">
				<div className="mb-2 flex items-center justify-between">
					<h3 className="font-semibold">{label} — choose active accounts</h3>
					<button
						type="button"
						onClick={onClose}
						className="text-sm opacity-50 hover:opacity-100"
					>
						✕
					</button>
				</div>
				<p className="mb-3 text-xs opacity-60">
					{accounts.length} connected · {selected.size} active. Only active
					accounts can be posted to (here and via Claude). Inactive ones stay
					connected but hidden.
				</p>

				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder={`Search ${accounts.length} accounts…`}
					className="mb-2 w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				/>

				<div className="mb-2 flex items-center gap-3 text-xs">
					<button
						type="button"
						onClick={() => setMany(filteredIds, true)}
						className="text-primary hover:underline"
					>
						Select{query ? " matching" : " all"}
					</button>
					<button
						type="button"
						onClick={() => setMany(filteredIds, false)}
						className="text-primary hover:underline"
					>
						Clear{query ? " matching" : " all"}
					</button>
					<span className="ml-auto opacity-50">{filtered.length} shown</span>
				</div>

				<div className="flex-1 space-y-1 overflow-y-auto rounded-md border border-black/10 p-2">
					{filtered.length === 0 && (
						<p className="p-2 text-xs opacity-40">No matches.</p>
					)}
					{filtered.map((a) => {
						const name = a.handle ?? a.displayName ?? a.accountId;
						return (
							<label
								key={a.accountId}
								className={`flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm ${
									selected.has(a.accountId)
										? "bg-primary/5"
										: "hover:bg-black/5"
								}`}
							>
								<input
									type="checkbox"
									checked={selected.has(a.accountId)}
									onChange={() => toggle(a.accountId)}
									className="accent-primary"
								/>
								<span className="truncate">{name}</span>
								{a.displayName && a.handle && (
									<span className="truncate text-xs opacity-40">
										{a.displayName}
									</span>
								)}
							</label>
						);
					})}
				</div>

				<div className="mt-3 flex items-center justify-end gap-2">
					<button
						type="button"
						onClick={onClose}
						className="rounded-md px-3 py-1.5 text-sm text-black/60 hover:bg-black/5"
					>
						Cancel
					</button>
					<button
						type="button"
						onClick={save}
						disabled={busy}
						className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
					>
						{busy ? "Saving…" : `Save (${selected.size} active)`}
					</button>
				</div>
			</div>
		</div>
	);
}
