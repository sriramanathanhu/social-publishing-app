import Link from "next/link";
import { redirect } from "next/navigation";
import { EditableName } from "@/components/editable-name";
import { getCurrentUser } from "@/lib/auth";
import { getAllEcosystems } from "@/lib/queries";
import { isAdmin } from "@/lib/rbac";

const PLATFORM_LABEL: Record<string, string> = {
	twitter: "X",
	youtube: "YT",
	linkedin: "in",
	pinterest: "Pin",
	bluesky: "BS",
	tiktok: "TT",
	instagram: "IG",
	facebook: "FB",
	threads: "Th",
};

/**
 * Admin: all ecosystems with their connected platforms. Kept compact — one row
 * per ecosystem, platforms shown as small chips, so a large account base stays
 * scannable.
 */
export default async function AdminEcosystemsPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/");
	if (!isAdmin(user)) redirect("/accounts");

	const ecosystems = await getAllEcosystems();
	const totalConnections = ecosystems.reduce((n, e) => n + e.integrations.length, 0);

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
						</tr>
					</thead>
					<tbody>
						{ecosystems.length === 0 && (
							<tr>
								<td colSpan={3} className="px-4 py-6 text-center opacity-50">
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
								<td className="px-4 py-3 opacity-70">{e.teamName}</td>
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
													{PLATFORM_LABEL[i.platform] ?? i.platform}
												</span>
											))}
										</span>
									)}
								</td>
							</tr>
						))}
					</tbody>
				</table>
			</div>
		</div>
	);
}
