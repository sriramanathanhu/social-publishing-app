"use client";

import { type Ecosystem, PublishRow, readJson } from "@/components/publish-row";

export type ArchiveItem = {
	key: string;
	type: "Dubbed" | "Original";
	language: string;
	title: string;
	caption: string;
	videoUrl: string;
};

/** One shared table of every generated dub + short, each publishable inline to
 * the viewer's own ecosystems. */
export function ArchiveTable({
	items,
	ecosystems,
}: {
	items: ArchiveItem[];
	ecosystems: Ecosystem[];
}) {
	if (items.length === 0) {
		return (
			<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
				Nothing generated yet. Dubs and shorts from across the team will appear
				here.
			</p>
		);
	}
	return (
		<div className="space-y-3">
			<div className="hidden gap-3 px-3 text-xs font-medium uppercase tracking-wide opacity-40 md:grid md:grid-cols-[96px_1fr_1.5fr_220px]">
				<div>Video · Type · Language</div>
				<div>Title</div>
				<div>Description / Caption</div>
				<div>Publish to</div>
			</div>
			{items.map((it) => (
				<PublishRow
					key={it.key}
					previewUrl={it.videoUrl}
					dubSourceUrl={it.videoUrl}
					tags={[
						{ label: it.type, tone: it.type === "Dubbed" ? "dub" : "orig" },
						{ label: it.language, tone: "lang" },
					]}
					initialTitle={it.title}
					initialCaption={it.caption}
					ecosystems={ecosystems}
					prepareMedia={async () => {
						// Re-host the public video into PostPeer media (works for anyone's
						// content — no ownership needed, just a public URL).
						const r = await fetch("/api/media/from-url", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ url: it.videoUrl }),
						});
						const d = await readJson(r);
						if (!r.ok) throw new Error(d.error ?? "Couldn’t prepare media");
						return d.publicUrl as string;
					}}
				/>
			))}
		</div>
	);
}
