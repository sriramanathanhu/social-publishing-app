import { desc, eq } from "drizzle-orm";
import Link from "next/link";
import { db } from "@/db";
import { quoteItems } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";

/** Library › Quotes: saved quotes and their rendered cards. */
export default async function QuotesLibraryPage() {
	const user = await requirePageUser();
	const items = await db
		.select({
			id: quoteItems.id,
			text: quoteItems.text,
			cardUrl: quoteItems.cardUrl,
		})
		.from(quoteItems)
		.where(eq(quoteItems.userId, user.id))
		.orderBy(desc(quoteItems.createdAt))
		.limit(300);

	if (items.length === 0) {
		return (
			<p className="text-slate-400 text-sm">
				No quotes yet — create some under{" "}
				<Link href="/quotes" className="text-blue-600 hover:underline">
					Content › Quotes
				</Link>
				.
			</p>
		);
	}

	return (
		<div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
			{items.map((q) =>
				q.cardUrl ? (
					<a
						key={q.id}
						href={q.cardUrl}
						target="_blank"
						rel="noreferrer"
						title={q.text}
					>
						{/* biome-ignore lint/performance/noImgElement: R2 card thumbnail */}
						<img
							src={q.cardUrl}
							alt={q.text.slice(0, 60)}
							className="aspect-[4/5] w-full rounded-lg border border-slate-200 object-cover"
						/>
					</a>
				) : (
					<div
						key={q.id}
						className="flex aspect-[4/5] w-full items-center justify-center rounded-lg border border-slate-200 bg-slate-50 p-3 text-center text-slate-600 text-xs"
					>
						{q.text.slice(0, 160)}
					</div>
				),
			)}
		</div>
	);
}
