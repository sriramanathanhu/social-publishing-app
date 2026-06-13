import { redirect } from "next/navigation";
import { CreateUser } from "@/components/create-user";
import { MemberRow } from "@/components/member-row";
import { getCurrentUser } from "@/lib/auth";
import { getAllMembers, getEcosystemOptions } from "@/lib/queries";
import { isAdmin } from "@/lib/rbac";

/** Admin: approve users and assign ecosystems. */
export default async function AdminMembersPage() {
	const user = await getCurrentUser();
	if (!user) redirect("/");
	if (!isAdmin(user)) redirect("/accounts");

	const [members, options] = await Promise.all([
		getAllMembers(),
		getEcosystemOptions(),
	]);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Members</h1>
				<p className="text-sm opacity-60">
					Approve users, set access level, and assign ecosystems. Ecosystems can only
					be assigned to approved users.
				</p>
			</div>

			<CreateUser />

			<div className="space-y-3">
				{members.map((m) => (
					<MemberRow
						key={m.id}
						member={m}
						options={options}
						isSelf={m.id === user.id}
					/>
				))}
			</div>
		</div>
	);
}
