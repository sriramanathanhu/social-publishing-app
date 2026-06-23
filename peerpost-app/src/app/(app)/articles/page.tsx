import { desc, eq } from "drizzle-orm";
import { ArticleStudio } from "@/components/article-studio";
import { db } from "@/db";
import { articles } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";
import { vertexConfigured } from "@/lib/vertex-search";

/**
 * Articles: enter a topic → retrieve the most relevant passages from the
 * uploaded corpus (Vertex AI Search) → Gemini/NVIDIA writes a grounded,
 * cited long-form article. Saved per user, editable, publishable to the
 * viewer's ecosystems.
 */
export default async function ArticlesPage() {
	const user = await requirePageUser();
	const profiles = await getAccessibleProfiles(user);
	const [rows, ecosystems] = await Promise.all([
		db
			.select()
			.from(articles)
			.where(eq(articles.userId, user.id))
			.orderBy(desc(articles.createdAt))
			.limit(100),
		Promise.all(
			profiles.map(async (p) => ({
				id: p.id,
				name: p.name,
				teamName: p.teamName,
				accounts: await getConnectedAccounts(p.id),
			})),
		),
	]);
	return (
		<ArticleStudio
			initialArticles={rows}
			ecosystems={ecosystems}
			corpusReady={vertexConfigured()}
		/>
	);
}
