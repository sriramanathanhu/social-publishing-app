import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { ArticlesLibrary } from "@/components/articles-library";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { loadTags } from "@/lib/library-tags";
import { requirePageUser } from "@/lib/page-auth";

function snippet(md: string): string {
	return md
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`>#[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 220);
}

/** Library › Articles: all generated articles with tags + search/sort. */
export default async function ArticlesLibraryPage() {
	const user = await requirePageUser();
	const rows = await db
		.select({
			id: articles.id,
			title: articles.title,
			topic: articles.topic,
			content: articles.content,
			provider: articles.provider,
			createdAt: articles.createdAt,
		})
		.from(articles)
		.where(eq(articles.userId, user.id))
		.orderBy(desc(articles.createdAt))
		.limit(300);

	if (rows.length === 0) {
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

	const tags = await loadTags(
		user.id,
		"article",
		rows.map((r) => r.id),
	);

	return (
		<ArticlesLibrary
			items={rows.map((a) => ({
				id: a.id,
				title: a.title || a.topic,
				snippet: snippet(a.content),
				provider: a.provider,
				tags: tags[a.id] ?? [],
				createdAt: String(a.createdAt),
			}))}
		/>
	);
}
