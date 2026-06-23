import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { QuotesLibrary } from "@/components/quotes-library";
import { db } from "@/db";
import { quoteItems } from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

/** Library › Quotes: saved quotes + rendered cards, with tags/filter + bulk publish. */
export default async function QuotesLibraryPage() {
	const user = await requirePageUser();
	const [items, profiles] = await Promise.all([
		db
			.select({
				id: quoteItems.id,
				text: quoteItems.text,
				cardUrl: quoteItems.cardUrl,
				createdAt: quoteItems.createdAt,
			})
			.from(quoteItems)
			.where(eq(quoteItems.userId, user.id))
			.orderBy(desc(quoteItems.createdAt))
			.limit(300),
		getAccessibleProfiles(user),
	]);
	const tags = await loadTags(
		user.id,
		"quote",
		items.map((i) => i.id),
	);
	const ecosystems = await Promise.all(
		profiles.map(async (p) => ({
			id: p.id,
			name: p.name,
			teamName: p.teamName,
			accounts: await getConnectedAccounts(p.id),
		})),
	);

	if (items.length === 0) {
		return (
			<p className="text-slate-400 text-sm">
				No quotes yet — create some under{" "}
				<Link href="/quotes" className="text-blue-600 hover:underline">
					Content › Quotes/Image Cards
				</Link>
				.
			</p>
		);
	}

	return (
		<QuotesLibrary
			ecosystems={ecosystems}
			items={items.map((i) => ({
				id: i.id,
				text: i.text,
				cardUrl: i.cardUrl,
				tags: tags[i.id] ?? [],
				createdAt: String(i.createdAt),
			}))}
		/>
	);
}
