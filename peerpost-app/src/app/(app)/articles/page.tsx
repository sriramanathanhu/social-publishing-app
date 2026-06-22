import { desc, eq } from "drizzle-orm";
import { ArticleStudio } from "@/components/article-studio";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { vertexConfigured } from "@/lib/vertex-search";

/**
 * Articles: enter a topic → retrieve the most relevant passages from the
 * uploaded corpus (Vertex AI Search) → Gemini/NVIDIA writes a grounded,
 * cited long-form article. Saved per user, editable, with source citations.
 */
export default async function ArticlesPage() {
	const user = await requirePageUser();
	const rows = await db
		.select()
		.from(articles)
		.where(eq(articles.userId, user.id))
		.orderBy(desc(articles.createdAt))
		.limit(100);
	return (
		<ArticleStudio initialArticles={rows} corpusReady={vertexConfigured()} />
	);
}
