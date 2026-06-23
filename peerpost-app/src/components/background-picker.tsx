"use client";

import { useRef } from "react";
import type { QuoteBackground } from "@/components/quote-types";

/**
 * Modal to choose a card background from the gallery (or upload a one-off).
 * Picking an image calls onSelect(url) and closes.
 */
export function BackgroundPicker({
	backgrounds,
	onSelect,
	onClose,
	onUploadFile,
	uploadBusy,
}: {
	backgrounds: QuoteBackground[];
	onSelect: (url: string) => void;
	onClose: () => void;
	onUploadFile?: (file: File) => void;
	uploadBusy?: boolean;
}) {
	const fileRef = useRef<HTMLInputElement>(null);
	return (
		<div
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
			onClick={onClose}
			onKeyDown={(e) => e.key === "Escape" && onClose()}
			role="presentation"
		>
			<div
				className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-xl bg-white p-4 shadow-xl"
				onClick={(e) => e.stopPropagation()}
				role="presentation"
			>
				<div className="mb-3 flex items-center justify-between">
					<h3 className="font-semibold text-slate-800 text-sm">
						Choose from gallery
					</h3>
					<div className="flex items-center gap-2">
						{onUploadFile && (
							<button
								type="button"
								onClick={() => fileRef.current?.click()}
								disabled={uploadBusy}
								className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50 disabled:opacity-50"
							>
								{uploadBusy ? "Uploading…" : "Upload from device"}
							</button>
						)}
						<button
							type="button"
							onClick={onClose}
							className="rounded-md border border-slate-300 px-2.5 py-1 text-xs hover:bg-slate-50"
						>
							Close
						</button>
						<input
							ref={fileRef}
							type="file"
							accept="image/jpeg,image/png,image/webp"
							className="hidden"
							onChange={(e) => {
								const f = e.target.files?.[0];
								if (f) onUploadFile?.(f);
								e.target.value = "";
							}}
						/>
					</div>
				</div>
				{backgrounds.length === 0 ? (
					<p className="text-slate-400 text-sm">
						No backgrounds in the gallery yet. An admin can add them under
						Library › Photo.
					</p>
				) : (
					<div className="grid grid-cols-3 gap-2 overflow-y-auto sm:grid-cols-5">
						{backgrounds.map((b) => (
							<button
								type="button"
								key={b.id}
								onClick={() => {
									onSelect(b.url);
									onClose();
								}}
								className="overflow-hidden rounded-lg border border-slate-200 hover:ring-2 hover:ring-slate-900"
								title={b.label ?? "background"}
							>
								{/* biome-ignore lint/performance/noImgElement: gallery thumbnail */}
								<img
									src={b.url}
									alt={b.label ?? "background"}
									className="aspect-[4/5] w-full object-cover"
								/>
							</button>
						))}
					</div>
				)}
			</div>
		</div>
	);
}
