import { Sidebar } from "@/components/sidebar";
import { requirePageUser } from "@/lib/page-auth";
import { isAdmin } from "@/lib/rbac";

/** Authenticated shell: sidebar nav + auth guard for all /app pages. */
export default async function AppLayout({
	children,
}: {
	children: React.ReactNode;
}) {
	const user = await requirePageUser();

	return (
		// h-screen + overflow-hidden pins the shell to the viewport so only the
		// main column scrolls; the sidebar stays fixed.
		<div className="flex h-screen overflow-hidden">
			<Sidebar
				user={{ name: user.name, email: user.email, isAdmin: isAdmin(user) }}
			/>
			<main className="flex-1 overflow-y-auto">
				<div className="mx-auto max-w-4xl p-8">{children}</div>
			</main>
		</div>
	);
}
