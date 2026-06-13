"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import {
	buildPlatformData,
	CHAR_LIMITS,
	type FieldDef,
	PLATFORM_FIELDS,
	PLATFORM_LABELS,
	PLATFORM_MEDIA,
} from "@/lib/platform-fields";

type ConnectedAccount = { platform: string; accountId: string; handle: string | null };
type MediaItem = { type: "image" | "video" | "gif"; url: string; name: string };
type PlatformResult = { platform: string; success: boolean; error?: string };
type Opts = Record<string, Record<string, unknown>>;

async function uploadFile(file: File): Promise<{ publicUrl: string; type: string; name: string }> {
	const fd = new FormData();
	fd.append("file", file);
	const res = await fetch("/api/media/upload", { method: "POST", body: fd });
	if (!res.ok) {
		const d = await res.json().catch(() => ({}));
		throw new Error(d.error ?? "Upload failed");
	}
	return res.json();
}

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
	const [opts, setOpts] = useState<Opts>({});
	const [boards, setBoards] = useState<Record<string, { id: string; name: string }[]>>({});

	const selectedAccounts = accounts.filter((a) => selected.has(a.accountId));
	const hasVideo = media.some((m) => m.type === "video");
	const hasMedia = media.length > 0;
	const minCharLimit = Math.min(
		...selectedAccounts.map((a) => CHAR_LIMITS[a.platform] ?? Infinity),
	);

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
	const getOpt = (acc: string, key: string) => opts[acc]?.[key];
	function setOpt(acc: string, key: string, value: unknown) {
		setOpts((prev) => ({ ...prev, [acc]: { ...prev[acc], [key]: value } }));
	}

	async function attachMedia(file: File) {
		setUploading(true);
		setMsg(null);
		try {
			const { publicUrl, type, name } = await uploadFile(file);
			setMedia((prev) => [...prev, { type: type as MediaItem["type"], url: publicUrl, name }]);
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Upload failed");
		} finally {
			setUploading(false);
		}
	}

	// Validation
	const problems: string[] = [];
	if (!content.trim()) problems.push("Add some text.");
	if (selectedAccounts.length === 0) problems.push("Select at least one account.");
	for (const a of selectedAccounts) {
		const label = PLATFORM_LABELS[a.platform] ?? a.platform;
		const need = PLATFORM_MEDIA[a.platform];
		if (need === "video" && !hasVideo) problems.push(`${label} requires a video.`);
		if (need === "required" && !hasMedia) problems.push(`${label} requires an image or video.`);
		if (a.platform === "pinterest" && !getOpt(a.accountId, "boardId"))
			problems.push(`${label} requires a board.`);
	}
	if (Number.isFinite(minCharLimit) && content.length > minCharLimit)
		problems.push(`Text exceeds ${minCharLimit} characters.`);

	function platformDataFor(a: ConnectedAccount): Record<string, unknown> | undefined {
		const raw = opts[a.accountId] ?? {};
		let psd = buildPlatformData(a.platform, raw);
		if (a.platform === "twitter") {
			if (raw.__pollEnabled) {
				const pollOptions = [raw.__poll0, raw.__poll1, raw.__poll2, raw.__poll3]
					.map((s) => String(s ?? "").trim())
					.filter(Boolean);
				if (pollOptions.length >= 2)
					psd = {
						...(psd ?? {}),
						poll: { options: pollOptions, durationMinutes: Number(raw.__pollDuration ?? 1440) },
					};
			}
			const thread = String(raw.__thread ?? "")
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
			if (thread.length) psd = { ...(psd ?? {}), threadItems: thread.map((c) => ({ content: c })) };
		}
		return psd;
	}

	async function submit(publishNow: boolean) {
		setBusy(true);
		setMsg(null);
		setResults([]);
		try {
			const platforms = selectedAccounts.map((a) => ({
				platform: a.platform,
				accountId: a.accountId,
				platformSpecificData: platformDataFor(a),
			}));

			// Apply a YouTube video thumbnail (mediaItem-level) if provided.
			const ytThumb = selectedAccounts
				.filter((a) => a.platform === "youtube")
				.map((a) => getOpt(a.accountId, "__videoThumbnail"))
				.find(Boolean) as string | undefined;
			const mediaItems = media.length
				? media.map((m) =>
						m.type === "video" && ytThumb
							? { type: m.type, url: m.url, thumbnail: ytThumb }
							: { type: m.type, url: m.url },
					)
				: undefined;

			const res = await fetch(`/api/profiles/${profileId}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content,
					platforms,
					mediaItems,
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
			setOpts({});
			setScheduledFor("");
			router.refresh();
		} catch (err) {
			setMsg(err instanceof Error ? err.message : "Error");
		} finally {
			setBusy(false);
		}
	}

	function renderField(a: ConnectedAccount, f: FieldDef) {
		const acc = a.accountId;
		const cur = getOpt(acc, f.key);
		const val = (cur ?? f.default ?? "") as string;
		const id = `${acc}-${f.key}`;
		if (f.type === "checkbox") {
			const checked = cur === undefined ? Boolean(f.default) : Boolean(cur);
			return (
				<label key={id} className="flex items-center gap-2 text-xs">
					<input
						type="checkbox"
						checked={checked}
						onChange={(e) => setOpt(acc, f.key, e.target.checked)}
					/>
					{f.label}
				</label>
			);
		}
		const labelEl = (
			<span className="mb-0.5 block text-[11px] font-medium opacity-60">
				{f.label}
				{f.help ? <span className="font-normal opacity-60"> · {f.help}</span> : null}
			</span>
		);
		if (f.type === "select") {
			return (
				<div key={id}>
					{labelEl}
					<select
						value={val}
						onChange={(e) => setOpt(acc, f.key, e.target.value)}
						className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
					>
						{f.options?.map((o) => (
							<option key={o.value} value={o.value}>
								{o.label}
							</option>
						))}
					</select>
				</div>
			);
		}
		if (f.type === "textarea") {
			return (
				<div key={id} className="col-span-full">
					{labelEl}
					<textarea
						value={val}
						maxLength={f.max}
						placeholder={f.placeholder}
						onChange={(e) => setOpt(acc, f.key, e.target.value)}
						rows={2}
						className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
					/>
				</div>
			);
		}
		if (f.type === "media-url") {
			return (
				<div key={id}>
					{labelEl}
					<div className="flex items-center gap-2">
						<input
							value={val}
							placeholder="image URL"
							onChange={(e) => setOpt(acc, f.key, e.target.value)}
							className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
						/>
						<label className="cursor-pointer rounded-md border border-black/15 px-2 py-1.5 text-xs hover:bg-black/5">
							Upload
							<input
								type="file"
								accept="image/*"
								className="hidden"
								onChange={async (e) => {
									const file = e.target.files?.[0];
									e.target.value = "";
									if (!file) return;
									try {
										const { publicUrl } = await uploadFile(file);
										setOpt(acc, f.key, publicUrl);
									} catch {
										setMsg("Image upload failed");
									}
								}}
							/>
						</label>
					</div>
				</div>
			);
		}
		// text / url / number / tags
		return (
			<div key={id}>
				{labelEl}
				<input
					type={f.type === "number" ? "number" : "text"}
					value={val}
					maxLength={f.max}
					placeholder={f.placeholder}
					onChange={(e) => setOpt(acc, f.key, e.target.value)}
					className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
				/>
			</div>
		);
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
			{/* Accounts */}
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
							{PLATFORM_LABELS[a.platform] ?? a.platform}
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
					<div className={`text-right text-xs ${content.length > minCharLimit ? "text-red-600" : "opacity-50"}`}>
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
							if (f) attachMedia(f);
							e.target.value = "";
						}}
					/>
				</label>
				{media.map((m) => (
					<span key={m.url} className="flex items-center gap-1 rounded bg-black/5 px-2 py-1 text-xs">
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
			{selectedAccounts.map((a) => (
				<div
					key={a.accountId}
					className="space-y-3 rounded-md border border-black/10 bg-black/[0.02] p-3"
				>
					<div className="text-xs font-semibold">
						{PLATFORM_LABELS[a.platform] ?? a.platform} options
						{a.handle ? ` · ${a.handle}` : ""}
					</div>

					{/* Pinterest board (required) */}
					{a.platform === "pinterest" && (
						<div>
							<span className="mb-0.5 block text-[11px] font-medium opacity-60">
								Board · required
							</span>
							<select
								value={(getOpt(a.accountId, "boardId") as string) ?? ""}
								onChange={(e) => setOpt(a.accountId, "boardId", e.target.value)}
								className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
							>
								<option value="">Select a board…</option>
								{(boards[a.accountId] ?? []).map((b) => (
									<option key={b.id} value={b.id}>
										{b.name}
									</option>
								))}
							</select>
						</div>
					)}

					<div className="grid gap-2 sm:grid-cols-2">
						{(PLATFORM_FIELDS[a.platform] ?? []).map((f) => renderField(a, f))}
					</div>

					{/* YouTube video thumbnail (mediaItem-level) */}
					{a.platform === "youtube" &&
						renderField(a, {
							key: "__videoThumbnail",
							label: "Video thumbnail (regular videos, ≤2MB)",
							type: "media-url",
						})}

					{/* Twitter poll + thread */}
					{a.platform === "twitter" && (
						<div className="space-y-2">
							<label className="flex items-center gap-2 text-xs">
								<input
									type="checkbox"
									checked={Boolean(getOpt(a.accountId, "__pollEnabled"))}
									onChange={(e) => setOpt(a.accountId, "__pollEnabled", e.target.checked)}
								/>
								Add a poll (no media/thread with a poll)
							</label>
							{Boolean(getOpt(a.accountId, "__pollEnabled")) && (
								<div className="grid gap-2 sm:grid-cols-2">
									{[0, 1, 2, 3].map((i) => (
										<input
											key={i}
											placeholder={`Option ${i + 1}${i < 2 ? " (required)" : ""}`}
											value={(getOpt(a.accountId, `__poll${i}`) as string) ?? ""}
											onChange={(e) => setOpt(a.accountId, `__poll${i}`, e.target.value)}
											className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
										/>
									))}
									<select
										value={(getOpt(a.accountId, "__pollDuration") as string) ?? "1440"}
										onChange={(e) => setOpt(a.accountId, "__pollDuration", e.target.value)}
										className="rounded-md border border-black/15 px-2 py-1.5 text-sm"
									>
										<option value="60">1 hour</option>
										<option value="1440">1 day</option>
										<option value="4320">3 days</option>
										<option value="10080">7 days</option>
									</select>
								</div>
							)}
							<div>
								<span className="mb-0.5 block text-[11px] font-medium opacity-60">
									Thread — additional tweets (one per line)
								</span>
								<textarea
									rows={2}
									value={(getOpt(a.accountId, "__thread") as string) ?? ""}
									onChange={(e) => setOpt(a.accountId, "__thread", e.target.value)}
									className="w-full rounded-md border border-black/15 px-2 py-1.5 text-sm"
								/>
							</div>
						</div>
					)}
				</div>
			))}

			{/* Hints */}
			{selectedAccounts.length > 0 && problems.length > 0 && (
				<ul className="space-y-0.5 rounded-md bg-amber-50 p-2 text-xs text-amber-700">
					{problems.map((p) => (
						<li key={p}>• {p}</li>
					))}
				</ul>
			)}

			{/* Results */}
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
