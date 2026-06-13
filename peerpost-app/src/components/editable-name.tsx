"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Inline editable name that PATCHes `endpoint` with `{name}`.
 * Reused for teams (/api/teams/:id) and ecosystems (/api/profiles/:id).
 */
export function EditableName({
	endpoint,
	name,
	className,
}: {
	endpoint: string;
	name: string;
	className?: string;
}) {
	const router = useRouter();
	const [editing, setEditing] = useState(false);
	const [value, setValue] = useState(name);
	const [busy, setBusy] = useState(false);

	async function save() {
		if (!value.trim() || value === name) {
			setEditing(false);
			return;
		}
		setBusy(true);
		try {
			await fetch(endpoint, {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ name: value.trim() }),
			});
			setEditing(false);
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	if (!editing) {
		return (
			<span className={className}>
				{name}
				<button
					type="button"
					onClick={() => {
						setValue(name);
						setEditing(true);
					}}
					className="ml-2 text-xs font-normal text-primary hover:underline"
				>
					Edit
				</button>
			</span>
		);
	}

	return (
		<span className="inline-flex items-center gap-2">
			<input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				className="rounded-md border border-black/15 px-2 py-1 text-sm"
			/>
			<button
				type="button"
				onClick={save}
				disabled={busy}
				className="rounded-md bg-primary px-2 py-1 text-xs text-white disabled:opacity-50"
			>
				{busy ? "…" : "Save"}
			</button>
			<button
				type="button"
				onClick={() => setEditing(false)}
				className="text-xs text-black/50 hover:underline"
			>
				Cancel
			</button>
		</span>
	);
}
