"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type ConnectedAccount = {
	platform: string;
	accountId: string;
	handle: string | null;
};

/**
 * Post composer (req #6). Pick connected accounts, write content, attach media
 * (presign → S3 PUT → publicUrl), then publish now or schedule.
 */
export function Composer({
	profileId,
	accounts,
	canPost,
}: {
	profileId: string;
	accounts: ConnectedAccount[];
	canPost: boolean;
}) {
	const router = useRouter();
	const [content, setContent] = useState("");
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [mediaUrls, setMediaUrls] = useState<{ type: string; url: string }[]>([]);
	const [scheduledFor, setScheduledFor] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);

	function toggle(accountId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(accountId) ? next.delete(accountId) : next.add(accountId);
			return next;
		});
	}

	async function uploadMedia(file: File) {
		const presign = await fetch("/api/media/upload", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ filename: file.name, mimeType: file.type }),
		});
		if (!presign.ok) throw new Error("Presign failed");
		const { uploadUrl, publicUrl } = await presign.json();
		await fetch(uploadUrl, {
			method: "PUT",
			headers: { "Content-Type": file.type },
			body: file,
		});
		const type = file.type.startsWith("video") ? "video" : "image";
		setMediaUrls((prev) => [...prev, { type, url: publicUrl }]);
	}

	async function submit(publishNow: boolean) {
		setBusy(true);
		setMsg(null);
		try {
			const platforms = accounts
				.filter((a) => selected.has(a.accountId))
				.map((a) => ({ platform: a.platform, accountId: a.accountId }));
			if (platforms.length === 0) throw new Error("Select at least one account");

			const res = await fetch(`/api/profiles/${profileId}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content,
					platforms,
					mediaItems: mediaUrls.length ? mediaUrls : undefined,
					publishNow: publishNow || undefined,
					scheduledFor: !publishNow ? new Date(scheduledFor).toISOString() : undefined,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}),
			});
			const data = await res.json();
			if (!res.ok) throw new Error(data.error ?? "Failed");
			setMsg(publishNow ? "Published ✓" : "Scheduled ✓");
			setContent("");
			setSelected(new Set());
			setMediaUrls([]);
			setScheduledFor("");
			router.refresh();
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	if (accounts.length === 0) {
		return (
			<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
				Connect at least one platform above to start posting.
			</p>
		);
	}

	return (
		<div className="space-y-3 rounded-lg border border-black/10 p-4">
			<div className="flex flex-wrap gap-2">
				{accounts.map((a) => (
					<button
						type="button"
						key={a.accountId}
						onClick={() => toggle(a.accountId)}
						className={`rounded-full border px-3 py-1 text-xs ${
							selected.has(a.accountId)
								? "border-primary bg-primary text-white"
								: "border-black/15"
						}`}
					>
						{a.platform}
						{a.handle ? ` · ${a.handle}` : ""}
					</button>
				))}
			</div>

			<textarea
				value={content}
				onChange={(e) => setContent(e.target.value)}
				rows={4}
				placeholder="What do you want to share?"
				className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
			/>

			<div className="flex flex-wrap items-center gap-3">
				<label className="cursor-pointer text-xs underline opacity-70">
					Attach media
					<input
						type="file"
						accept="image/*,video/*"
						className="hidden"
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) uploadMedia(f).catch(() => setMsg("Upload failed"));
						}}
					/>
				</label>
				{mediaUrls.map((m) => (
					<span key={m.url} className="text-xs opacity-60">
						{m.type} attached
					</span>
				))}
			</div>

			<div className="flex flex-wrap items-center gap-3">
				<input
					type="datetime-local"
					value={scheduledFor}
					onChange={(e) => setScheduledFor(e.target.value)}
					className="rounded-md border border-black/15 px-2 py-1 text-sm"
				/>
				<button
					type="button"
					disabled={busy || !canPost || !scheduledFor}
					onClick={() => submit(false)}
					className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-40"
				>
					Schedule
				</button>
				<button
					type="button"
					disabled={busy || !canPost}
					onClick={() => submit(true)}
					className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-white disabled:opacity-40"
				>
					{busy ? "Working…" : "Publish now"}
				</button>
				{msg && <span className="text-sm opacity-70">{msg}</span>}
			</div>
		</div>
	);
}
