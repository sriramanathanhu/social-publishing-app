import Link from "next/link";
import { ArticlesLibrary } from "@/components/articles-library";
import { loadArticlesPage } from "@/lib/library-queries";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Articles: a SHARED gallery of every user's generated articles,
 * with tags, date/language/user filters, and server-side load-more. */
export default async function ArticlesLibraryPage() {
	const user = await requirePageUser();
	const { items, hasMore } = await loadArticlesPage(user.id, 0);

	if (items.length === 0) {
		return (
			<p className="text-slate-400 text-sm">
				No articles yet — create some under{" "}
				<Link href="/articles" className="text-blue-600 hover:underline">
					Content › Articles
				</Link>
				.
			</p>
		);
	}

	return <ArticlesLibrary items={items} hasMore={hasMore} />;
}
