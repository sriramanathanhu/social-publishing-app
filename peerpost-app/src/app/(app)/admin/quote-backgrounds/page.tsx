import { desc } from "drizzle-orm";
import { QuoteBackgroundsManager } from "@/components/quote-backgrounds-manager";
import { db } from "@/db";
import { quoteBackgrounds } from "@/db/schema";
import { requireAdminPage } from "@/lib/page-auth";

/** Admin: curated background photos users can pick when making quote cards. */
export default async function QuoteBackgroundsPage() {
	await requireAdminPage();
	const rows = await db
		.select({
			id: quoteBackgrounds.id,
			url: quoteBackgrounds.url,
			label: quoteBackgrounds.label,
		})
		.from(quoteBackgrounds)
		.orderBy(desc(quoteBackgrounds.createdAt));

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Quote backgrounds</h1>
				<p className="mt-1 text-sm opacity-60">
					Background photos users can pick from when turning a quote into an
					image card. The branded overlay (frame, quote box, handle) is applied
					automatically on top.
				</p>
			</div>
			<QuoteBackgroundsManager initial={rows} />
		</div>
	);
}
