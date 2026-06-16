"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Upload a yt-dlp cookies.txt (Netscape format) so the dubber can download
 * login-gated / rate-limited sources (Instagram, YouTube on a server IP).
 * Stored encrypted and passed per-job; never shown back.
 */
export function CookiesForm({ present }: { present: boolean }) {
	const router = useRouter();
	const [content, setContent] = useState("");
	const [fileName, setFileName] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [saved, setSaved] = useState<string | null>(null);

	async function pickFile(file: File | null) {
		setError(null);
		setSaved(null);
		if (!file) {
			setContent("");
			setFileName(null);
			return;
		}
		const text = await file.text();
		if (!text.includes("\t") && !text.includes("# Netscape")) {
			setError("That doesn't look like a Netscape cookies.txt file.");
			return;
		}
		setContent(text);
		setFileName(file.name);
	}

	async function save(value: string, successMsg: string) {
		setBusy(true);
		setError(null);
		setSaved(null);
		try {
			const res = await fetch("/api/keys", {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ cookies: value }),
			});
			if (!res.ok) {
				const d = await res.json().catch(() => ({}));
				throw new Error(d.error ?? "Failed to save cookies");
			}
			setContent("");
			setFileName(null);
			setSaved(successMsg);
			router.refresh();
		} catch (err) {
			setError(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	return (
		<div className="space-y-3 rounded-lg border border-black/10 p-4">
			<div>
				<div className="flex items-center gap-2 text-sm font-medium">
					Download cookies (yt-dlp)
					{present ? (
						<span className="rounded bg-green-100 px-1.5 py-0.5 text-xs text-green-700">
							set
						</span>
					) : (
						<span className="rounded bg-black/10 px-1.5 py-0.5 text-xs opacity-60">
							not set
						</span>
					)}
				</div>
				<p className="mt-1 text-xs opacity-50">
					Export a <code>cookies.txt</code> (Netscape format) from a browser
					logged into the platform — use a “Get cookies.txt” extension. Needed
					for Instagram and YouTube from this server. Cookies expire; re-upload
					when downloads start failing. To cover multiple platforms, concatenate
					their cookies into one file.
				</p>
			</div>

			<input
				type="file"
				accept=".txt"
				onChange={(e) => pickFile(e.target.files?.[0] ?? null)}
				className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
			/>
			{fileName && (
				<p className="text-xs opacity-60">
					Loaded {fileName} ({content.split("\n").filter(Boolean).length} lines)
				</p>
			)}

			<div className="flex items-center gap-3">
				<button
					type="button"
					disabled={busy || !content}
					onClick={() => save(content, "Cookies saved.")}
					className="h-10 rounded-md bg-primary px-4 text-sm font-medium text-white disabled:opacity-50"
				>
					{busy ? "Saving…" : "Save cookies"}
				</button>
				{present && (
					<button
						type="button"
						disabled={busy}
						onClick={() => save("", "Cookies cleared.")}
						className="h-10 rounded-md border border-black/15 px-3 text-sm hover:bg-black/5 disabled:opacity-50"
					>
						Clear
					</button>
				)}
				{saved && <span className="text-sm text-green-600">{saved}</span>}
				{error && <span className="text-sm text-red-600">{error}</span>}
			</div>
		</div>
	);
}
