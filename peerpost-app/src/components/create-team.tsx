"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Admin-only: create a new team. */
export function CreateTeam() {
	const router = useRouter();
	const [name, setName] = useState("");
	const [description, setDescription] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setError(null);
		try {
			const res = await fetch("/api/teams", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name, description: description || undefined }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.error ?? "Failed to create team");
			}
			setName("");
			setDescription("");
			router.refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<form
			onSubmit={submit}
			className="flex flex-col gap-2 rounded-lg border border-black/10 p-4 sm:flex-row sm:items-end"
		>
			<div className="flex-1">
				<label className="mb-1 block text-xs font-medium opacity-60">Team name</label>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
					maxLength={200}
					placeholder="e.g. Marketing"
					className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				/>
			</div>
			<div className="flex-1">
				<label className="mb-1 block text-xs font-medium opacity-60">
					Description (optional)
				</label>
				<input
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					maxLength={1000}
					className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				/>
			</div>
			<button
				type="submit"
				disabled={busy}
				className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
			>
				{busy ? "Creating…" : "Create team"}
			</button>
			{error && <p className="text-sm text-red-600">{error}</p>}
		</form>
	);
}
