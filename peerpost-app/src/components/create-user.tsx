"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Admin: pre-register a user by email (linked on their first Nandi login). */
export function CreateUser() {
	const router = useRouter();
	const [email, setEmail] = useState("");
	const [name, setName] = useState("");
	const [role, setRole] = useState("user");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	async function submit(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setMsg(null);
		try {
			const res = await fetch("/api/users", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ email, name: name || undefined, role }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.error ?? "Failed to create user");
			}
			setEmail("");
			setName("");
			setRole("user");
			router.refresh();
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
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
				<label className="mb-1 block text-xs font-medium opacity-60">
					Email
				</label>
				<input
					type="email"
					value={email}
					onChange={(e) => setEmail(e.target.value)}
					required
					placeholder="user@email.com"
					className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				/>
			</div>
			<div className="flex-1">
				<label className="mb-1 block text-xs font-medium opacity-60">
					Name (optional)
				</label>
				<input
					value={name}
					onChange={(e) => setName(e.target.value)}
					className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				/>
			</div>
			<div>
				<label className="mb-1 block text-xs font-medium opacity-60">
					Access
				</label>
				<select
					value={role}
					onChange={(e) => setRole(e.target.value)}
					className="rounded-md border border-black/15 px-2 py-2 text-sm"
				>
					<option value="user">user</option>
					<option value="admin">admin</option>
				</select>
			</div>
			<button
				type="submit"
				disabled={busy}
				className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
			>
				{busy ? "Adding…" : "Add user"}
			</button>
			{msg && <p className="text-sm text-red-600">{msg}</p>}
		</form>
	);
}
