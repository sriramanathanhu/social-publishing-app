import { requireAdminPage } from "@/lib/page-auth";
import { eq } from "drizzle-orm";
import { CreateTeam } from "@/components/create-team";
import { EditableName } from "@/components/editable-name";
import { db } from "@/db";
import { profiles } from "@/db/schema";
import { getTeamsForUser } from "@/lib/queries";

/** Admin-only: create and rename teams (organisational containers). */
export default async function AdminTeamsPage() {
	const user = await requireAdminPage();

	const teams = await getTeamsForUser(user);
	const withCounts = await Promise.all(
		teams.map(async (t) => {
			const rows = await db
				.select({ id: profiles.id })
				.from(profiles)
				.where(eq(profiles.teamId, t.id));
			return { ...t, ecosystemCount: rows.length };
		}),
	);

	return (
		<div className="space-y-6">
			<div>
				<h1 className="text-xl font-semibold">Teams</h1>
				<p className="text-sm opacity-60">
					Teams group ecosystems. Assign user access under Admin → Members.
				</p>
			</div>

			<CreateTeam />

			<div className="space-y-2">
				{withCounts.map((t) => (
					<div
						key={t.id}
						className="flex items-center justify-between rounded-lg border border-black/10 p-4"
					>
						<EditableName endpoint={`/api/teams/${t.id}`} name={t.name} className="font-medium" />
						<span className="rounded-full bg-black/5 px-2 py-0.5 text-xs">
							{t.ecosystemCount} ecosystems
						</span>
					</div>
				))}
			</div>
		</div>
	);
}
