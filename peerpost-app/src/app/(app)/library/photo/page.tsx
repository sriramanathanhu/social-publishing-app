import { desc } from "drizzle-orm";
import { GalleryManager } from "@/components/gallery-manager";
import { db } from "@/db";
import { quoteBackgrounds, quoteOverlays } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { isAdmin } from "@/lib/rbac";

/** Library › Photo: background photos + brand overlays for quote cards. */
export default async function PhotoLibraryPage() {
	const user = await requirePageUser();
	const editable = isAdmin(user);
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
			<p className="text-slate-500 text-sm">
				Backgrounds and overlays for quote cards.
				{editable ? "" : " (Upload/manage is admin-only.)"}
			</p>
			<GalleryManager
				title="Backgrounds"
				hint="JPEG/PNG/WebP · ideally portrait (1080×1350)"
				items={bgs}
				uploadUrl="/api/quotes/backgrounds"
				deleteBase="/api/quotes/backgrounds"
				accept="image/jpeg,image/png,image/webp"
				editable={editable}
			/>
			<GalleryManager
				title="Overlays"
				hint="Transparent PNG · 1080×1350 (frame + quote box + handle)"
				items={overlays}
				uploadUrl="/api/quotes/overlays"
				deleteBase="/api/quotes/overlays"
				accept="image/png"
				checkered
				editable={editable}
			/>
		</div>
	);
}
