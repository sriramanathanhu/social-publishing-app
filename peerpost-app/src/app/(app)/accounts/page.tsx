import { requirePageUser } from "@/lib/page-auth";
import { eq } from "drizzle-orm";
import Link from "next/link";
import { CreateProfile } from "@/components/create-profile";
import { EditableName } from "@/components/editable-name";
import { db } from "@/db";
import { integrationsCache } from "@/db/schema";
import { getAccessibleProfilesInTeam, getTeamsForUser } from "@/lib/queries";
import { isAdmin } from "@/lib/rbac";
import { cn } from "@/lib/utils";

/**
 * Connected Accounts: shows ecosystems the user can access (admins see all,
 * grouped by team). Unapproved / unassigned users see an awaiting-access note.
 */
export default async function AccountsPage({
	searchParams,
}: {
	searchParams: Promise<{ team?: string }>;
}) {
	const user = await requirePageUser();

	const admin = isAdmin(user);
	const teams = await getTeamsForUser(user);
	const { team: teamParam } = await searchParams;
	const activeTeam = teams.find((t) => t.id === teamParam) ?? teams[0];

	// No accessible ecosystems → awaiting-access state (requirement #3).
	if (!activeTeam) {
		return (
			<div>
				<h1 className="mb-3 text-xl font-semibold">Connected Accounts</h1>
				<div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800">
					{admin ? (
						<>No teams yet. Create one under Admin → Teams.</>
					) : !user.approved ? (
						<>
							Your account is awaiting admin approval. Once approved and assigned an
							ecosystem, you&apos;ll be able to connect platforms and publish here.
						</>
					) : (
						<>
							You haven&apos;t been assigned any ecosystems yet. Ask an admin to assign
							you one under Members.
						</>
					)}
				</div>
			</div>
		);
	}

	const profiles = await getAccessibleProfilesInTeam(user, activeTeam.id);
	const counts = await Promise.all(
		profiles.map(async (p) => {
			const rows = await db
				.select({ id: integrationsCache.id })
				.from(integrationsCache)
				.where(eq(integrationsCache.profileId, p.id));
			return [p.id, rows.length] as const;
		}),
	);
	const countById = new Map(counts);

	return (
		<div className="space-y-6">
			<h1 className="text-xl font-semibold">Connected Accounts</h1>

			{/* Team selector */}
			<div className="flex flex-wrap gap-2">
				{teams.map((t) => (
					<Link
						key={t.id}
						href={`/accounts?team=${t.id}`}
						className={cn(
							"rounded-full border px-3 py-1 text-sm",
							t.id === activeTeam.id
								? "border-primary bg-primary text-white"
								: "border-black/15 hover:bg-black/5",
						)}
					>
						{t.name}
					</Link>
				))}
			</div>

			{/* Active team header with admin rename */}
			<div className="flex items-baseline justify-between">
				<h2 className="text-base font-medium">
					{admin ? (
						<EditableName endpoint={`/api/teams/${activeTeam.id}`} name={activeTeam.name} />
					) : (
						activeTeam.name
					)}
				</h2>
			</div>

			{/* Ecosystems in the team */}
			<div className="space-y-2">
				{profiles.length === 0 && (
					<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
						{admin
							? "No ecosystems in this team yet. Create one below."
							: "No ecosystems assigned to you in this team."}
					</p>
				)}
				{profiles.map((p) => (
					<Link
						key={p.id}
						href={`/accounts/${p.id}`}
						className="flex items-center justify-between rounded-lg border border-black/10 p-4 transition-colors hover:bg-black/5"
					>
						<div>
							<div className="font-medium">{p.name}</div>
							{p.description && (
								<div className="text-sm opacity-60">{p.description}</div>
							)}
						</div>
						<span className="rounded-full bg-black/5 px-2 py-0.5 text-xs">
							{countById.get(p.id) ?? 0} connected
						</span>
					</Link>
				))}
			</div>

			{/* Only admins create ecosystems. */}
			{admin && (
				<div>
					<h2 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-50">
						Add an Ecosystem to {activeTeam.name}
					</h2>
					<CreateProfile teamId={activeTeam.id} />
				</div>
			)}
		</div>
	);
}
