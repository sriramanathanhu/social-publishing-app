import { desc } from "drizzle-orm";
import { PhotoLibrary } from "@/components/photo-library";
import { db } from "@/db";
import { quoteBackgrounds, quoteOverlays } from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";
import { isAdmin } from "@/lib/rbac";

/** Library › Photo: background photos + brand overlays, with tags + search. */
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
	const [bgTags, ovTags] = await Promise.all([
		loadTags(
			user.id,
			"background",
			bgs.map((b) => b.id),
		),
		loadTags(
			user.id,
			"overlay",
			overlays.map((o) => o.id),
		),
	]);

	return (
		<div className="space-y-3">
			{!editable && (
				<p className="text-slate-400 text-xs">
					Upload/delete is admin-only; you can still tag and search.
				</p>
			)}
			<PhotoLibrary
				editable={editable}
				sections={[
					{
						kind: "background",
						title: "Backgrounds",
						uploadUrl: "/api/quotes/backgrounds",
						deleteBase: "/api/quotes/backgrounds",
						accept: "image/jpeg,image/png,image/webp",
						items: bgs.map((b) => ({
							id: b.id,
							url: b.url,
							label: b.label,
							tags: bgTags[b.id] ?? [],
						})),
					},
					{
						kind: "overlay",
						title: "Overlays",
						uploadUrl: "/api/quotes/overlays",
						deleteBase: "/api/quotes/overlays",
						accept: "image/png",
						checkered: true,
						items: overlays.map((o) => ({
							id: o.id,
							url: o.url,
							label: o.label,
							tags: ovTags[o.id] ?? [],
						})),
					},
				]}
			/>
		</div>
	);
}
