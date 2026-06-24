import Link from "next/link";
import { QuotesLibrary } from "@/components/quotes-library";
import { loadQuotesPage } from "@/lib/library-queries";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

/** Library › Quotes: a SHARED gallery of everyone's saved quotes + rendered
 * cards, with tags, bulk publish, date/language/user filters, and load-more. */
export default async function QuotesLibraryPage() {
	const user = await requirePageUser();
	const [{ items, hasMore }, profiles] = await Promise.all([
		loadQuotesPage(user.id, 0),
		getAccessibleProfiles(user),
	]);
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
		<QuotesLibrary ecosystems={ecosystems} items={items} hasMore={hasMore} />
	);
}
