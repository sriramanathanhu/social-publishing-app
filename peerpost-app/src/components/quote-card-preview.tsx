"use client";

/** Full-size lightbox for a rendered quote card. */
export function QuoteCardPreview({
	url,
	onClose,
}: {
	readonly url: string;
	readonly onClose: () => void;
}) {
	return (
		<button
			type="button"
			onClick={onClose}
			aria-label="Close preview"
			className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
		>
			<div className="flex max-h-full flex-col items-center gap-2">
				{/* biome-ignore lint/performance/noImgElement: full-size remote card */}
				<img
					src={url}
					alt="quote card"
					className="max-h-[85vh] w-auto rounded-lg shadow-2xl"
				/>
				<div className="flex gap-3 text-sm text-white">
					<a
						href={url}
						download="quote-card.png"
						target="_blank"
						rel="noopener noreferrer"
						onClick={(e) => e.stopPropagation()}
						className="underline hover:no-underline"
					>
						Download PNG ↓
					</a>
					<span className="opacity-60">click anywhere to close</span>
				</div>
			</div>
		</button>
	);
}
