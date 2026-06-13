"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";

type EcoOption = { id: string; name: string; teamName: string };
type Member = {
	id: string;
	email: string | null;
	name: string | null;
	role: string;
	approved: boolean;
	pending: boolean;
	ecosystems: { id: string; name: string }[];
};

function initials(name: string | null, email: string | null) {
	const base = name ?? email ?? "?";
	return base.slice(0, 2).toUpperCase();
}

/**
 * One member card: identity, approve toggle, access level, and a friendly
 * ecosystem-assignment panel (grouped by team, searchable, select-all).
 */
export function MemberRow({
	member,
	options,
	isSelf,
}: {
	member: Member;
	options: EcoOption[];
	isSelf: boolean;
}) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState(false);
	const [query, setQuery] = useState("");
	const [selected, setSelected] = useState<Set<string>>(
		new Set(member.ecosystems.map((e) => e.id)),
	);

	const canAssign = member.approved || member.role === "admin";

	// Group ecosystem options by team, filtered by the search query.
	const grouped = useMemo(() => {
		const q = query.trim().toLowerCase();
		const map = new Map<string, EcoOption[]>();
		for (const o of options) {
			if (q && !o.name.toLowerCase().includes(q) && !o.teamName.toLowerCase().includes(q))
				continue;
			const arr = map.get(o.teamName) ?? [];
			arr.push(o);
			map.set(o.teamName, arr);
		}
		return [...map.entries()];
	}, [options, query]);

	async function patch(body: Record<string, unknown>) {
		setBusy(true);
		try {
			await fetch(`/api/users/${member.id}`, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	async function saveAssignments() {
		setBusy(true);
		try {
			await fetch(`/api/users/${member.id}/ecosystems`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ profileIds: [...selected] }),
			});
			setEditing(false);
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	function toggle(id: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(id) ? next.delete(id) : next.add(id);
			return next;
		});
	}

	function setTeam(items: EcoOption[], on: boolean) {
		setSelected((prev) => {
			const next = new Set(prev);
			for (const i of items) on ? next.add(i.id) : next.delete(i.id);
			return next;
		});
	}

	function startEdit() {
		setSelected(new Set(member.ecosystems.map((e) => e.id)));
		setQuery("");
		setEditing(true);
	}

	return (
		<div className="rounded-xl border border-black/10 p-4">
			{/* Identity + controls */}
			<div className="flex flex-wrap items-center justify-between gap-3">
				<div className="flex min-w-0 items-center gap-3">
					<span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-xs font-semibold text-primary">
						{initials(member.name, member.email)}
					</span>
					<div className="min-w-0">
						<div className="truncate font-medium">{member.name ?? member.email}</div>
						<div className="truncate text-xs opacity-50">{member.email}</div>
					</div>
				</div>

				<div className="flex flex-wrap items-center gap-2">
					{member.pending && (
						<span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700">
							invited
						</span>
					)}
					{member.role === "admin" ? (
						<span className="rounded-full bg-green-100 px-2 py-0.5 text-xs text-green-700">
							admin · full access
						</span>
					) : (
						<button
							type="button"
							disabled={busy || isSelf}
							onClick={() => patch({ approved: !member.approved })}
							className={`rounded-full px-2.5 py-1 text-xs font-medium ${
								member.approved
									? "bg-green-100 text-green-700 hover:bg-green-200"
									: "bg-amber-100 text-amber-700 hover:bg-amber-200"
							} disabled:opacity-50`}
						>
							{member.approved ? "Approved ✓" : "Approve"}
						</button>
					)}
					<select
						value={member.role}
						disabled={busy || isSelf}
						onChange={(e) => patch({ role: e.target.value })}
						className="rounded-md border border-black/15 px-2 py-1 text-xs disabled:opacity-50"
					>
						<option value="user">user</option>
						<option value="admin">admin</option>
					</select>
				</div>
			</div>

			{/* Assignment */}
			<div className="mt-3 border-t border-black/5 pt-3">
				{member.role === "admin" ? (
					<p className="text-xs opacity-50">Admins can access all ecosystems.</p>
				) : !canAssign ? (
					<p className="flex items-center gap-2 text-xs opacity-60">
						<span className="text-amber-600">●</span>
						Approve this user to assign ecosystems.
					</p>
				) : !editing ? (
					<div className="flex flex-wrap items-center gap-2">
						<span className="text-xs font-medium opacity-50">Ecosystems:</span>
						{member.ecosystems.length === 0 ? (
							<span className="text-xs opacity-40">none assigned</span>
						) : (
							member.ecosystems.map((e) => (
								<span
									key={e.id}
									className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
								>
									{e.name}
								</span>
							))
						)}
						<button
							type="button"
							onClick={startEdit}
							className="ml-1 rounded-md border border-black/15 px-2 py-0.5 text-xs hover:bg-black/5"
						>
							{member.ecosystems.length ? "Edit access" : "Assign ecosystems"}
						</button>
					</div>
				) : (
					<div className="space-y-3 rounded-lg bg-black/[0.02] p-3">
						<div className="flex items-center justify-between gap-2">
							<input
								value={query}
								onChange={(e) => setQuery(e.target.value)}
								placeholder="Filter ecosystems or teams…"
								className="w-full rounded-md border border-black/15 px-3 py-1.5 text-sm"
							/>
							<span className="shrink-0 text-xs font-medium opacity-60">
								{selected.size} selected
							</span>
						</div>

						<div className="max-h-64 space-y-3 overflow-y-auto pr-1">
							{grouped.length === 0 && (
								<p className="text-xs opacity-40">No matching ecosystems.</p>
							)}
							{grouped.map(([teamName, items]) => {
								const allOn = items.every((i) => selected.has(i.id));
								return (
									<div key={teamName}>
										<div className="mb-1 flex items-center justify-between">
											<span className="text-xs font-semibold uppercase tracking-wide opacity-50">
												{teamName}
											</span>
											<button
												type="button"
												onClick={() => setTeam(items, !allOn)}
												className="text-[11px] text-primary hover:underline"
											>
												{allOn ? "Clear all" : "Select all"}
											</button>
										</div>
										<div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
											{items.map((o) => (
												<label
													key={o.id}
													className={`flex cursor-pointer items-center gap-2 rounded-md border px-2.5 py-1.5 text-sm ${
														selected.has(o.id)
															? "border-primary bg-primary/5"
															: "border-black/10 hover:bg-black/5"
													}`}
												>
													<input
														type="checkbox"
														checked={selected.has(o.id)}
														onChange={() => toggle(o.id)}
														className="accent-primary"
													/>
													<span className="truncate">{o.name}</span>
												</label>
											))}
										</div>
									</div>
								);
							})}
						</div>

						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={saveAssignments}
								disabled={busy}
								className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-50"
							>
								{busy ? "Saving…" : "Save access"}
							</button>
							<button
								type="button"
								onClick={() => setEditing(false)}
								className="rounded-md px-3 py-1.5 text-sm text-black/60 hover:bg-black/5"
							>
								Cancel
							</button>
						</div>
					</div>
				)}
			</div>
		</div>
	);
}
