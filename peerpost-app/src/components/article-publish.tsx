"use client";

import { useMemo, useRef, useState } from "react";
import type { Ecosystem } from "@/components/publish-row";

/** Long-form-friendly platforms the article can be posted to. */
const ARTICLE_PLATFORMS = ["linkedin", "facebook", "reddit", "twitter"];
const PLATFORM_LABEL: Record<string, string> = {
	linkedin: "LinkedIn",
	facebook: "Facebook",
	reddit: "Reddit",
	twitter: "X (Twitter)",
};
// Soft character ceilings for a warning (X assumes a paid/Premium account).
const LIMITS: Record<string, number> = {
	linkedin: 3000,
	twitter: 25000,
	facebook: 63000,
	reddit: 40000,
};

type Result = {
	platform: string;
	status: "publishing" | "published" | "scheduled" | "failed";
	error?: string;
	url?: string;
};

/** Markdown → clean plain text for a social post (drop headings, emphasis,
 * citation markers; keep paragraphs and bullets). */
export function toPlainText(md: string): string {
	return md
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/(^|[^*])\*([^*]+)\*/g, "$1$2")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\s*\[\d+(?:\s*,\s*\d+)*\]/g, "")
		.replace(/^\s*[-*]\s+/gm, "• ")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

export function ArticlePublish({
	article,
	ecosystems,
}: {
	article: { title: string | null; topic: string; content: string };
	ecosystems: Ecosystem[];
}) {
	// Only ecosystems that actually have an article-capable account.
	const usable = useMemo(
		() =>
			ecosystems
				.map((e) => ({
					...e,
					accounts: e.accounts.filter((a) =>
						ARTICLE_PLATFORMS.includes(a.platform),
					),
				}))
				.filter((e) => e.accounts.length > 0),
		[ecosystems],
	);

	const [ecoId, setEcoId] = useState<string>(usable[0]?.id ?? "");
	const eco = usable.find((e) => e.id === ecoId) ?? null;
	const [selected, setSelected] = useState<Set<string>>(new Set());
	const [text, setText] = useState(() => toPlainText(article.content));
	const [imageUrl, setImageUrl] = useState<string | null>(null);
	const [uploadBusy, setUploadBusy] = useState(false);
	const [when, setWhen] = useState("");
	const [busy, setBusy] = useState(false);
	const [msg, setMsg] = useState<string | null>(null);
	const [results, setResults] = useState<Result[]>([]);
	const fileRef = useRef<HTMLInputElement>(null);

	const chosenAccounts =
		eco?.accounts.filter((a) => selected.has(a.accountId)) ?? [];
	const minLimit = Math.min(
		...chosenAccounts.map((a) => LIMITS[a.platform] ?? 100_000),
		100_000,
	);
	const tooLong = chosenAccounts.length > 0 && text.length > minLimit;

	function toggle(accountId: string) {
		setSelected((prev) => {
			const next = new Set(prev);
			if (next.has(accountId)) next.delete(accountId);
			else next.add(accountId);
			return next;
		});
	}

	async function uploadImage(file: File) {
		setUploadBusy(true);
		setMsg(null);
		try {
			const fd = new FormData();
			fd.append("file", file);
			const res = await fetch("/api/articles/image", {
				method: "POST",
				body: fd,
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Upload failed");
			setImageUrl(d.url);
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Upload failed");
		} finally {
			setUploadBusy(false);
		}
	}

	async function publish() {
		if (!eco || chosenAccounts.length === 0 || !text.trim()) return;
		setBusy(true);
		setMsg(null);
		setResults([]);
		const targets = chosenAccounts.map((a) => ({
			platform: a.platform,
			accountId: a.accountId,
			// Reddit needs a post title; harmless for the others.
			platformSpecificData:
				a.platform === "reddit"
					? { title: article.title ?? article.topic }
					: undefined,
		}));
		let jobs: { id: string; platform: string }[] = [];
		try {
			const res = await fetch(`/api/profiles/${eco.id}/posts`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					content: text,
					platforms: targets,
					mediaItems: imageUrl ? [{ type: "image", url: imageUrl }] : undefined,
					publishNow: when ? undefined : true,
					scheduledFor: when ? new Date(when).toISOString() : undefined,
					timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
					source: "article",
				}),
			});
			const d = await res.json();
			if (!res.ok) throw new Error(d.error ?? "Publish failed");
			jobs = d.jobs ?? [];
			if (jobs.length === 0) throw new Error("Nothing was queued.");
		} catch (e) {
			setMsg(e instanceof Error ? e.message : "Publish failed");
			setBusy(false);
			return;
		}
		setResults(
			jobs.map((j) => ({ platform: j.platform, status: "publishing" })),
		);
		setMsg(when ? "Scheduling…" : "Publishing…");
		pollStatuses(jobs, !!when);
	}

	function pollStatuses(
		jobs: { id: string; platform: string }[],
		sched: boolean,
	) {
		const ids = jobs.map((j) => j.id).join(",");
		const started = Date.now();
		const tick = async () => {
			try {
				const r = await fetch(`/api/profiles/${ecoId}/posts/status?ids=${ids}`);
				const d = await r.json();
				const byId = new Map(
					(d.statuses ?? []).map((s: { id: string }) => [s.id, s]),
				);
				const updated: Result[] = jobs.map((j) => {
					const s = byId.get(j.id) as
						| { status?: string; error?: string; url?: string }
						| undefined;
					const st = s?.status ?? "publishing";
					const status =
						st === "published" || st === "scheduled" || st === "failed"
							? (st as Result["status"])
							: "publishing";
					return { platform: j.platform, status, error: s?.error, url: s?.url };
				});
				setResults(updated);
				const pending = updated.some(
					(u) =>
						u.status === "publishing" || (u.status === "published" && !u.url),
				);
				if (pending && Date.now() - started < 180_000) {
					setTimeout(tick, 3000);
					return;
				}
				const failed = updated.filter((u) => u.status === "failed").length;
				setMsg(
					failed
						? `${updated.length - failed}/${updated.length} ${sched ? "scheduled" : "published"} · ${failed} failed`
						: sched
							? "Scheduled ✓"
							: "Published ✓",
				);
				setBusy(false);
			} catch {
				if (Date.now() - started < 180_000) setTimeout(tick, 4000);
				else {
					setMsg("Lost track of status — check the post log.");
					setBusy(false);
				}
			}
		};
		setTimeout(tick, 2000);
	}

	if (usable.length === 0) {
		return (
			<div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-slate-500 text-sm">
				No connected LinkedIn, Facebook, Reddit, or X account in your ecosystems
				yet. Connect one under <strong>Connected Accounts</strong> to publish
				articles.
			</div>
		);
	}

	return (
		<div className="rounded-xl border border-slate-200 bg-white p-4">
			<h3 className="mb-3 font-semibold text-slate-800 text-sm">Publish</h3>

			<div className="grid gap-4 md:grid-cols-2">
				<div>
					<label className="mb-1 block font-medium text-slate-500 text-xs">
						Ecosystem
					</label>
					<select
						value={ecoId}
						onChange={(e) => {
							setEcoId(e.target.value);
							setSelected(new Set());
						}}
						className="w-full rounded-lg border border-slate-300 px-3 py-2 text-sm"
					>
						{usable.map((e) => (
							<option key={e.id} value={e.id}>
								{e.teamName} › {e.name}
							</option>
						))}
					</select>

					<div className="mt-3 space-y-1.5">
						{eco?.accounts.map((a) => (
							<label
								key={a.accountId}
								className="flex items-center gap-2 text-slate-700 text-sm"
							>
								<input
									type="checkbox"
									checked={selected.has(a.accountId)}
									onChange={() => toggle(a.accountId)}
								/>
								<span className="font-medium">
									{PLATFORM_LABEL[a.platform] ?? a.platform}
								</span>
								{a.handle && (
									<span className="text-slate-400 text-xs">@{a.handle}</span>
								)}
							</label>
						))}
					</div>

					<div className="mt-3">
						<label className="mb-1 block font-medium text-slate-500 text-xs">
							Image (optional)
						</label>
						{imageUrl ? (
							<div className="flex items-center gap-2">
								{/* biome-ignore lint/performance/noImgElement: external R2 URL preview */}
								<img
									src={imageUrl}
									alt="attachment"
									className="h-14 w-14 rounded object-cover"
								/>
								<button
									type="button"
									onClick={() => setImageUrl(null)}
									className="text-red-600 text-xs hover:underline"
								>
									Remove
								</button>
							</div>
						) : (
							<button
								type="button"
								onClick={() => fileRef.current?.click()}
								disabled={uploadBusy}
								className="rounded-lg border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
							>
								{uploadBusy ? "Uploading…" : "Upload image"}
							</button>
						)}
						<input
							ref={fileRef}
							type="file"
							accept="image/jpeg,image/png,image/webp,image/gif"
							className="hidden"
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) uploadImage(f);
								e.target.value = "";
							}}
						/>
					</div>
				</div>

				<div className="flex flex-col">
					<label className="mb-1 block font-medium text-slate-500 text-xs">
						Post text
					</label>
					<textarea
						value={text}
						onChange={(e) => setText(e.target.value)}
						className="min-h-[160px] flex-1 resize-y rounded-lg border border-slate-300 p-3 text-sm focus:border-slate-500 focus:outline-none"
					/>
					<div className="mt-1 flex items-center justify-between text-xs">
						<span className={tooLong ? "text-amber-600" : "text-slate-400"}>
							{text.length.toLocaleString()} chars
							{tooLong &&
								` · exceeds ${minLimit.toLocaleString()} limit for a selected platform`}
						</span>
						<button
							type="button"
							onClick={() => setText(toPlainText(article.content))}
							className="text-slate-400 hover:text-slate-600"
						>
							Reset to article
						</button>
					</div>
				</div>
			</div>

			<div className="mt-4 flex flex-wrap items-center gap-3 border-slate-100 border-t pt-3">
				<input
					type="datetime-local"
					value={when}
					onChange={(e) => setWhen(e.target.value)}
					className="rounded-lg border border-slate-300 px-3 py-2 text-sm"
				/>
				<button
					type="button"
					onClick={publish}
					disabled={busy || chosenAccounts.length === 0 || !text.trim()}
					className="rounded-lg bg-slate-900 px-4 py-2 font-medium text-sm text-white disabled:opacity-40"
				>
					{busy
						? "Working…"
						: when
							? `Schedule to ${chosenAccounts.length}`
							: `Publish to ${chosenAccounts.length}`}
				</button>
				{msg && <span className="text-slate-600 text-sm">{msg}</span>}
			</div>

			{results.length > 0 && (
				<div className="mt-3 space-y-1 text-xs">
					{results.map((r) => (
						<div key={r.platform} className="flex items-center gap-2">
							<span className="font-medium text-slate-600">
								{PLATFORM_LABEL[r.platform] ?? r.platform}
							</span>
							<span
								className={
									r.status === "failed"
										? "text-red-600"
										: r.status === "published" || r.status === "scheduled"
											? "text-green-600"
											: "text-slate-400"
								}
							>
								{r.status}
								{r.error ? ` — ${r.error}` : ""}
							</span>
							{r.url && (
								<a
									href={r.url}
									target="_blank"
									rel="noreferrer"
									className="text-blue-600 hover:underline"
								>
									view
								</a>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
