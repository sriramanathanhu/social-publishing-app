"use client";

import { useState } from "react";

/** Inline tag chips with add/remove, persisted to /api/library/tags. Reports
 * changes via onChange so the parent can keep tags for filtering. */
export function TagEditor({
	kind,
	itemId,
	initial,
	onChange,
}: {
	kind: string;
	itemId: string;
	initial: string[];
	onChange?: (tags: string[]) => void;
}) {
	const [tags, setTags] = useState<string[]>(initial);
	const [input, setInput] = useState("");

	function commit(next: string[]) {
		setTags(next);
		onChange?.(next);
	}

	function add() {
		const t = input.trim();
		setInput("");
		if (!t || tags.includes(t)) return;
		commit([...tags, t]);
		fetch("/api/library/tags", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind, itemId, tag: t }),
		}).catch(() => {});
	}

	function remove(t: string) {
		commit(tags.filter((x) => x !== t));
		fetch("/api/library/tags", {
			method: "DELETE",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ kind, itemId, tag: t }),
		}).catch(() => {});
	}

	return (
		<div className="flex flex-wrap items-center gap-1">
			{tags.map((t) => (
				<span
					key={t}
					className="inline-flex items-center gap-1 rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600"
				>
					{t}
					<button
						type="button"
						onClick={() => remove(t)}
						className="text-slate-400 hover:text-red-600"
						aria-label={`remove ${t}`}
					>
						×
					</button>
				</span>
			))}
			<input
				value={input}
				onChange={(e) => setInput(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						add();
					}
				}}
				placeholder="+ tag"
				className="w-16 rounded border border-transparent px-1 text-[11px] hover:border-slate-200 focus:border-slate-300 focus:outline-none"
			/>
		</div>
	);
}
