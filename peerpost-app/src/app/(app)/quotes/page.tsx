import { desc } from "drizzle-orm";
import { QuoteStudio } from "@/components/quote-studio";
import { db } from "@/db";
import { quoteBackgrounds } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";
import { getAccessibleProfiles, getConnectedAccounts } from "@/lib/queries";

/**
 * Quotes: paste long-form content → AI distills several powerful, postable
 * quotes (Gemini → NVIDIA), each publishable/schedulable to the viewer's own
 * ecosystems (text-capable accounts).
 */
export default async function QuotesPage() {
	const user = await requirePageUser();

	const profiles = await getAccessibleProfiles(user);
	const [ecosystems, backgrounds] = await Promise.all([
		Promise.all(
			profiles.map(async (p) => ({
				id: p.id,
				name: p.name,
				teamName: p.teamName,
				accounts: await getConnectedAccounts(p.id),
			})),
		),
		db
			.select({
				id: quoteBackgrounds.id,
				url: quoteBackgrounds.url,
				label: quoteBackgrounds.label,
			})
			.from(quoteBackgrounds)
			.orderBy(desc(quoteBackgrounds.createdAt)),
	]);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Quotes</h1>
				<p className="mt-1 text-sm opacity-60">
					Turn long-form content into powerful, ready-to-post quotes — then
					publish or schedule them to your ecosystems.
				</p>
			</div>
			<QuoteStudio ecosystems={ecosystems} backgrounds={backgrounds} />
		</div>
	);
}
