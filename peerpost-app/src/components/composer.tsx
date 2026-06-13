"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type ConnectedAccount = {
	platform: string;
	accountId: string;
	handle: string | null;
};

type MediaItem = { type: "image" | "video" | "gif"; url: string; name: string };
type PlatformResult = { platform: string; success: boolean; error?: string };

// Per-platform rules and which options we surface.
const META: Record<
	string,
	{ label: string; media: "video" | "required" | "optional"; charLimit?: number; board?: boolean }
> = {
	twitter: { label: "Twitter / X", media: "optional", charLimit: 280 },
	youtube: { label: "YouTube", media: "video" },
	linkedin: { label: "LinkedIn", media: "optional" },
	pinterest: { label: "Pinterest", media: "required", board: true },
	bluesky: { label: "Bluesky", media: "optional", charLimit: 300 },
	tiktok: { label: "TikTok", media: "required" },
	instagram: { label: "Instagram", media: "required" },
	facebook: { label: "Facebook", media: "optional" },
	threads: { label: "Threads", media: "optional" },
};

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
	const [media, setMedia] = useState<MediaItem[]>([]);
	const [uploading, setUploading] = useState(false);
	const [scheduledFor, setScheduledFor] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<PlatformResult[]>([]);

	// platformSpecificData per accountId
	const [opts, setOpts] = useState<Record<string, Record<string, unknown>>>({});
	// pinterest boards per accountId
	const [boards, setBoards] = useState<Record<string, { id: string; name: string }[]>>({});

	const selectedAccounts = accounts.filter((a) => selected.has(a.accountId));
	const hasVideo = media.some((m) => m.type === "video");
	const hasMedia = media.length > 0;
	const minCharLimit = Math.min(
		...selectedAccounts.map((a) => META[a.platform]?.charLimit ?? Infinity),
	);

	// Fetch Pinterest boards when a pinterest account is selected.
	useEffect(() => {
		for (const a of selectedAccounts) {
			if (a.platform === "pinterest" && !boards[a.accountId]) {
				fetch(`/api/profiles/${profileId}/pinterest-boards?accountId=${a.accountId}`)
					.then((r) => r.json())
					.then((d) => setBoards((b) => ({ ...b, [a.accountId]: d.boards ?? [] })))
					.catch(() => {});
			}
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [selected]);

	function toggle(accountId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			next.has(accountId) ? next.delete(accountId) : next.add(accountId);
			return next;
		});
	}

	function setOpt(accountId: string, key: string, value: unknown) {
		setOpts((prev) => ({ ...prev, [accountId]: { ...prev[accountId], [key]: value } }));
	}

	async function uploadMedia(file: File) {
		setUploading(true);
		setMsg(null);
		try {
			const presign = await fetch("/api/media/upload", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ filename: file.name, mimeType: file.type }),
			});
			if (!presign.ok) {
				const d = await presign.json().catch(() => ({}));
				throw new Error(d.error ?? "Could not get upload URL");
			}
			const { uploadUrl, publicUrl } = await presign.json();
			const put = await fetch(uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": file.type },
				body: file,
			});
			if (!put.ok) throw new Error(`Upload to storage failed (${put.status})`);
			const type = file.type.startsWith("video") ? "video" : "image";
			setMedia((prev) => [...prev, { type, url: publicUrl, name: file.name }]);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploading(false);
		}
	}

	// Requirements not yet satisfied (block publish until empty).
	const problems: string[] = [];
	if (!content.trim()) problems.push("Add some text.");
	if (selectedAccounts.length === 0) problems.push("Select at least one account.");
	for (const a of selectedAccounts) {
		const m = META[a.platform];
		if (!m) continue;
		if (m.media === "video" && !hasVideo)
			problems.push(`${m.label} requires a video.`);
		if (m.media === "required" && !hasMedia)
			problems.push(`${m.label} requires an image or video.`);
		if (m.board && !opts[a.accountId]?.boardId)
			problems.push(`${m.label} requires a board.`);
	}
	if (Number.isFinite(minCharLimit) && content.length > minCharLimit)
		problems.push(`Text exceeds ${minCharLimit} characters.`);

	function buildPlatformData(a: ConnectedAccount): Record<string, unknown> | undefined {
		const o = opts[a.accountId] ?? {};
		const clean: Record<string, unknown> = {};
		if (a.platform === "youtube") {
			if (o.title) clean.title = o.title;
			if (o.visibility) clean.visibility = o.visibility;
			if (o.madeForKids != null) clean.madeForKids = o.madeForKids;
		} else if (a.platform === "pinterest") {
			if (o.boardId) clean.boardId = o.boardId;
			if (o.title) clean.title = o.title;
			if (o.link) clean.link = o.link;
		} else if (a.platform === "tiktok") {
			if (o.privacyLevel) clean.privacyLevel = o.privacyLevel;
		}
		return Object.keys(clean).length ? clean : undefined;
	}

	async function submit(publishNow: boolean) {
		setBusy(true);
		setMsg(null);
		setResults([]);
		try {
			const platforms = selectedAccounts.map((a) => ({
				platform: a.platform,
				accountId: a.accountId,
				platformSpecificData: buildPlatformData(a),
			}));

			const res = await fetch(`/api/profiles/${profileId}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content,
					platforms,
					mediaItems: media.length
						? media.map((m) => ({ type: m.type, url: m.url }))
						: undefined,
					publishNow: publishNow || undefined,
					scheduledFor: !publishNow ? new Date(scheduledFor).toISOString() : undefined,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
				}),
			});
			const data = await res.json();
			if (!res.ok) {
				setResults(data.platforms ?? []);
				throw new Error(data.error ?? "Failed");
			}
			setResults(data.platforms ?? []);
			setMsg(publishNow ? "Published ✓" : "Scheduled ✓");
			setContent("");
			setSelected(new Set());
			setMedia([]);
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
				No connected accounts on this ecosystem yet. Connect a platform first.
			</p>
		);
	}

	return (
		<div className="space-y-4 rounded-lg border border-black/10 p-4">
			{/* Account selection */}
			<div>
				<div className="mb-1 text-xs font-medium opacity-60">Post to</div>
				<div className="flex flex-wrap gap-2">
					{accounts.map((a) => (
						<button
							type="button"
							key={a.accountId}
							onClick={() => toggle(a.accountId)}
							className={`rounded-full border px-3 py-1 text-xs ${
								selected.has(a.accountId)
									? "border-primary bg-primary text-white"
									: "border-black/15 hover:bg-black/5"
							}`}
						>
							{META[a.platform]?.label ?? a.platform}
							{a.handle ? ` · ${a.handle}` : ""}
						</button>
					))}
				</div>
			</div>

			{/* Content */}
			<div>
				<textarea
					value={content}
					onChange={(e) => setContent(e.target.value)}
					rows={4}
					placeholder="What do you want to share?"
					className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				/>
				{Number.isFinite(minCharLimit) && (
					<div
						className={`text-right text-xs ${
							content.length > minCharLimit ? "text-red-600" : "opacity-50"
						}`}
					>
						{content.length}/{minCharLimit}
					</div>
				)}
			</div>

			{/* Media */}
			<div className="flex flex-wrap items-center gap-3">
				<label className="cursor-pointer rounded-md border border-black/15 px-3 py-1.5 text-xs hover:bg-black/5">
					{uploading ? "Uploading…" : "+ Attach image / video"}
					<input
						type="file"
						accept="image/*,video/*"
						className="hidden"
						disabled={uploading}
						onChange={(e) => {
							const f = e.target.files?.[0];
							if (f) uploadMedia(f);
							e.target.value = "";
						}}
					/>
				</label>
				{media.map((m) => (
					<span
						key={m.url}
						className="flex items-center gap-1 rounded bg-black/5 px-2 py-1 text-xs"
					>
						{m.type === "video" ? "🎬" : "🖼"} {m.name}
						<button
							type="button"
							onClick={() => setMedia((prev) => prev.filter((x) => x.url !== m.url))}
							className="ml-1 text-red-600"
						>
							×
						</button>
					</span>
				))}
			</div>

			{/* Per-platform options */}
			{selectedAccounts.map((a) => {
				const m = META[a.platform];
				const o = opts[a.accountId] ?? {};
				if (!m) return null;
				const showOptions = ["youtube", "pinterest", "tiktok"].includes(a.platform);
				if (!showOptions) return null;
				return (
					<div
						key={a.accountId}
						className="space-y-2 rounded-md border border-black/10 bg-black/[0.02] p-3"
					>
						<div className="text-xs font-semibold">
							{m.label} options{a.handle ? ` · ${a.handle}` : ""}
						</div>

						{a.platform === "youtube" && (
							<div className="grid gap-2 sm:grid-cols-2">
								<input
									placeholder="Title (defaults to your text)"
									value={(o.title as string) ?? ""}
									onChange={(e) => setOpt(a.accountId, "title", e.target.value)}
									className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
								/>
								<select
									value={(o.visibility as string) ?? "public"}
									onChange={(e) => setOpt(a.accountId, "visibility", e.target.value)}
									className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
								>
									<option value="public">Public</option>
									<option value="unlisted">Unlisted</option>
									<option value="private">Private</option>
								</select>
								<label className="col-span-full flex items-center gap-2 text-xs">
									<input
										type="checkbox"
										checked={!!o.madeForKids}
										onChange={(e) => setOpt(a.accountId, "madeForKids", e.target.checked)}
									/>
									Made for kids (COPPA)
								</label>
							</div>
						)}

						{a.platform === "pinterest" && (
							<div className="grid gap-2 sm:grid-cols-2">
								<select
									value={(o.boardId as string) ?? ""}
									onChange={(e) => setOpt(a.accountId, "boardId", e.target.value)}
									className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
								>
									<option value="">Select a board (required)…</option>
									{(boards[a.accountId] ?? []).map((b) => (
										<option key={b.id} value={b.id}>
											{b.name}
										</option>
									))}
								</select>
								<input
									placeholder="Destination link (optional)"
									value={(o.link as string) ?? ""}
									onChange={(e) => setOpt(a.accountId, "link", e.target.value)}
									className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
								/>
							</div>
						)}

						{a.platform === "tiktok" && (
							<select
								value={(o.privacyLevel as string) ?? "PUBLIC_TO_EVERYONE"}
								onChange={(e) => setOpt(a.accountId, "privacyLevel", e.target.value)}
								className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
							>
								<option value="PUBLIC_TO_EVERYONE">Public</option>
								<option value="MUTUAL_FOLLOW_FRIENDS">Friends</option>
								<option value="FOLLOWER_OF_CREATOR">Followers</option>
								<option value="SELF_ONLY">Private</option>
							</select>
						)}
					</div>
				);
			})}

			{/* Requirement hints */}
			{selectedAccounts.length > 0 && problems.length > 0 && (
				<ul className="space-y-0.5 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
					{problems.map((p) => (
						<li key={p}>• {p}</li>
					))}
				</ul>
			)}

			{/* Per-platform results */}
			{results.length > 0 && (
				<ul className="space-y-0.5 text-xs">
					{results.map((r) => (
						<li key={r.platform} className={r.success ? "text-green-700" : "text-red-600"}>
							{r.success ? "✓" : "✗"} {r.platform}
							{r.error ? ` — ${r.error}` : ""}
						</li>
					))}
				</ul>
			)}

			{/* Actions */}
			<div className="flex flex-wrap items-center gap-3 border-t border-black/5 pt-3">
				<input
					type="datetime-local"
					value={scheduledFor}
					onChange={(e) => setScheduledFor(e.target.value)}
					className="rounded-md border border-black/15 px-2 py-1 text-sm"
				/>
				<button
					type="button"
					disabled={busy || !canPost || !scheduledFor || problems.length > 0}
					onClick={() => submit(false)}
					className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5 disabled:opacity-40"
				>
					Schedule
				</button>
				<button
					type="button"
					disabled={busy || !canPost || problems.length > 0}
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
