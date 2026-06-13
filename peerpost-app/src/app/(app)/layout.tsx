import { requirePageUser } from "@/lib/page-auth";
import { Sidebar } from "@/components/sidebar";
import { isAdmin } from "@/lib/rbac";

/** Authenticated shell: sidebar nav + auth guard for all /app pages. */
export default async function AppLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await requirePageUser();

	return (
		<div className="flex min-h-screen">
			<Sidebar
				user={{ name: user.name, email: user.email, isAdmin: isAdmin(user) }}
			/>
			<main className="flex-1 overflow-y-auto">
				<div className="mx-auto max-w-4xl p-8">{children}</div>
			</main>
		</div>
	);
}
