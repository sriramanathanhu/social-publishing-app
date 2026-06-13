"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Key = {
	id: string;
	label: string;
	createdAt: string | Date;
	lastUsedAt: string | Date | null;
};

export function ApiKeysManager({ keys }: { keys: Key[] }) {
	const router = useRouter();
	const [label, setLabel] = useState("");
	const [busy, setBusy] = useState(false);
	const [secret, setSecret] = useState<string | null>(null);
	const [err, setErr] = useState<string | null>(null);

	async function create(e: React.FormEvent) {
		e.preventDefault();
		setBusy(true);
		setErr(null);
		setSecret(null);
		try {
			const res = await fetch("/api/api-keys", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ label }),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? "Failed");
			setSecret(data.key.secret);
			setLabel("");
			router.refresh();
		} catch (e2) {
			setErr(e2 instanceof Error ? e2.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	async function revoke(id: string) {
		if (
			!confirm("Revoke this key? Any Claude connection using it stops working.")
		)
			return;
		await fetch("/api/api-keys", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id }),
		});
		router.refresh();
	}

	return (
		<div className="space-y-4">
			<form
				onSubmit={create}
				className="flex flex-wrap items-end gap-2 rounded-lg border border-black/10 p-4"
			>
				<div className="flex-1">
					<label className="mb-1 block text-xs font-medium opacity-60">
						New key label
					</label>
					<input
						value={label}
						onChange={(e) => setLabel(e.target.value)}
						required
						maxLength={100}
						placeholder="e.g. Claude desktop"
						className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
					/>
				</div>
				<button
					type="submit"
					disabled={busy}
					className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? "Creating…" : "Generate key"}
				</button>
				{err && <p className="text-sm text-red-600">{err}</p>}
			</form>

			{secret && (
				<div className="rounded-lg border border-green-200 bg-green-50 p-4 text-sm">
					<p className="mb-1 font-medium text-green-800">
						Copy your key now — it won&apos;t be shown again:
					</p>
					<code className="block break-all rounded bg-white px-2 py-1 font-mono text-xs">
						{secret}
					</code>
				</div>
			)}

			<ul className="space-y-2">
				{keys.length === 0 && (
					<li className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
						No API keys yet.
					</li>
				)}
				{keys.map((k) => (
					<li
						key={k.id}
						className="flex items-center justify-between rounded-lg border border-black/10 px-4 py-3 text-sm"
					>
						<div>
							<div className="font-medium">{k.label}</div>
							<div className="text-xs opacity-50">
								Created {new Date(k.createdAt).toLocaleDateString()} ·{" "}
								{k.lastUsedAt
									? `last used ${new Date(k.lastUsedAt).toLocaleDateString()}`
									: "never used"}
							</div>
						</div>
						<button
							type="button"
							onClick={() => revoke(k.id)}
							className="text-xs text-red-600 hover:underline"
						>
							Revoke
						</button>
					</li>
				))}
			</ul>
		</div>
	);
}
