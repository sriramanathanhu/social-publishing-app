import Link from "next/link";
import { EditableName } from "@/components/editable-name";
import { LinkZernio } from "@/components/link-zernio";
import { LinkZernioGroup } from "@/components/link-zernio-group";
import { TeamSelect } from "@/components/team-select";
import { requireAdminPage } from "@/lib/page-auth";
import { PLATFORM_SHORT } from "@/lib/platform-fields";
import { getAllEcosystems, getTeamsForUser } from "@/lib/queries";

/**
 * Admin: all ecosystems with their connected platforms. Kept compact — one row
 * per ecosystem, platforms shown as small chips, so a large account base stays
 * scannable.
 */
export default async function AdminEcosystemsPage() {
	const user = await requireAdminPage();

	const [ecosystems, teams] = await Promise.all([
		getAllEcosystems(),
		getTeamsForUser(user),
	]);
	const totalConnections = ecosystems.reduce(
		(n, e) => n + e.integrations.length,
		0,
	);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Ecosystems</h1>
				<p className="text-sm opacity-60">
					{ecosystems.length} ecosystems · {totalConnections} connected accounts
				</p>
			</div>

			<div className="overflow-hidden rounded-lg border border-black/10">
				<table className="w-full text-sm">
					<thead className="bg-black/[0.03] text-left text-xs uppercase tracking-wide opacity-60">
						<tr>
							<th className="px-4 py-2 font-medium">Ecosystem</th>
							<th className="px-4 py-2 font-medium">Team</th>
							<th className="px-4 py-2 font-medium">Connected platforms</th>
							<th className="px-4 py-2 font-medium">Zernio</th>
						</tr>
					</thead>
					<tbody>
						{ecosystems.length === 0 && (
							<tr>
								<td colSpan={4} className="px-4 py-6 text-center opacity-50">
									No ecosystems yet.
								</td>
							</tr>
						)}
						{ecosystems.map((e) => (
							<tr key={e.id} className="border-t border-black/5">
								<td className="px-4 py-3 font-medium">
									<EditableName
										endpoint={`/api/profiles/${e.id}`}
										name={e.name}
									/>
									<Link
										href={`/accounts/${e.id}`}
										className="ml-2 text-xs font-normal text-primary hover:underline"
									>
										Open →
									</Link>
								</td>
								<td className="px-4 py-3">
									<TeamSelect
										ecosystemId={e.id}
										teamId={e.teamId}
										teams={teams}
									/>
								</td>
								<td className="px-4 py-3">
									{e.integrations.length === 0 ? (
										<span className="text-xs opacity-40">none</span>
									) : (
										<span className="flex flex-wrap gap-1">
											{e.integrations.map((i) => (
												<span
													key={`${i.platform}-${i.handle}`}
													title={`${i.platform}${i.handle ? ` · ${i.handle}` : ""}`}
													className="rounded bg-black/5 px-1.5 py-0.5 text-[11px]"
												>
													{PLATFORM_SHORT[i.platform] ?? i.platform}
												</span>
											))}
										</span>
									)}
								</td>
								<td className="px-4 py-3">
									<div className="flex flex-col gap-1.5">
										<LinkZernio ecosystemId={e.id} />
										<LinkZernioGroup ecosystemId={e.id} />
									</div>
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
