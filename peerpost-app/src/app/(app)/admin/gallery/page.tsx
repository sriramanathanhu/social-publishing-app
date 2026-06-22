import { desc } from "drizzle-orm";
import { GalleryManager } from "@/components/gallery-manager";
import { db } from "@/db";
import { quoteBackgrounds, quoteOverlays } from "@/db/schema";
import { requireAdminPage } from "@/lib/page-auth";

/** Admin gallery: background photos + brand overlays used to build quote cards. */
export default async function GalleryPage() {
	await requireAdminPage();
	const [bgs, overlays] = await Promise.all([
		db
			.select({
				id: quoteBackgrounds.id,
				url: quoteBackgrounds.url,
				label: quoteBackgrounds.label,
			})
			.from(quoteBackgrounds)
			.orderBy(desc(quoteBackgrounds.createdAt)),
		db
			.select({
				id: quoteOverlays.id,
				url: quoteOverlays.url,
				label: quoteOverlays.label,
			})
			.from(quoteOverlays)
			.orderBy(desc(quoteOverlays.createdAt)),
	]);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-xl font-semibold">Gallery</h1>
				<p className="mt-1 text-sm opacity-60">
					Backgrounds and overlays for quote cards. Users pick a background (and
					optionally an overlay) when turning a quote into an image card.
				</p>
			</div>
			<GalleryManager
				title="Backgrounds"
				hint="JPEG/PNG/WebP · ideally portrait (1080×1350)"
				items={bgs}
				uploadUrl="/api/quotes/backgrounds"
				deleteBase="/api/quotes/backgrounds"
				accept="image/jpeg,image/png,image/webp"
			/>
			<GalleryManager
				title="Overlays"
				hint="Transparent PNG · 1080×1350 (frame + quote box + handle)"
				items={overlays}
				uploadUrl="/api/quotes/overlays"
				deleteBase="/api/quotes/overlays"
				accept="image/png"
				checkered
			/>
		</div>
	);
}
