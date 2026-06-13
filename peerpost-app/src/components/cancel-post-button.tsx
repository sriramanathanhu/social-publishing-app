"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Cancels a scheduled post via DELETE /api/posts/:id. */
export function CancelPostButton({ postId }: { postId: string }) {
	const router = useRouter();
	const [busy, setBusy] = useState(false);

	async function cancel() {
		if (!confirm("Cancel this scheduled post?")) return;
		setBusy(true);
		try {
			await fetch(`/api/posts/${postId}`, { method: "DELETE" });
			router.refresh();
		} finally {
			setBusy(false);
		}
	}

	return (
		<button
			type="button"
			onClick={cancel}
			disabled={busy}
			className="shrink-0 rounded-md border border-black/15 px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-40"
		>
			{busy ? "…" : "Cancel"}
		</button>
	);
}
