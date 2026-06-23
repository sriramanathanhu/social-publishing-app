import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";

function snippet(md: string): string {
	return md
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`>#[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 220);
}

/** Library › Articles: all generated articles. */
export default async function ArticlesLibraryPage() {
	const user = await requirePageUser();
	const rows = await db
		.select({
			id: articles.id,
			title: articles.title,
			topic: articles.topic,
			content: articles.content,
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

	return (
		<div className="space-y-2">
			{rows.map((a) => (
				<Link
					key={a.id}
					href="/articles"
					className="block rounded-lg border border-slate-200 bg-white p-4 hover:border-slate-300"
				>
					<div className="font-medium text-slate-900">{a.title || a.topic}</div>
					<div className="mt-1 text-slate-500 text-sm">
						{snippet(a.content)}…
					</div>
					<div className="mt-1 text-slate-400 text-xs">
						{new Date(a.createdAt).toLocaleDateString()}
					</div>
				</Link>
			))}
		</div>
	);
}
