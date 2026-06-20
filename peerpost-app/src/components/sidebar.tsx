"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { cn } from "@/lib/utils";

type NavUser = { name: string | null; email: string | null; isAdmin: boolean };

const linkBase =
	"block rounded-md px-3 py-2 text-sm transition-colors hover:bg-black/5";

function NavLink({ href, label }: { href: string; label: string }) {
	const pathname = usePathname();
	const active = pathname === href || pathname.startsWith(`${href}/`);
	return (
		<Link
			href={href}
			className={cn(linkBase, active && "bg-black/5 font-medium text-primary")}
		>
			{label}
		</Link>
	);
}

export function Sidebar({ user }: { user: NavUser }) {
	const router = useRouter();

	async function logout() {
		await fetch("/api/auth/logout", { method: "POST" });
		router.push("/");
		router.refresh();
	}

	return (
		<aside className="flex h-screen w-60 shrink-0 flex-col border-r border-black/10 p-4">
			<div className="mb-6 px-2">
				<div className="text-lg font-semibold">PeerPost</div>
				<div className="text-xs opacity-50">Social publishing</div>
			</div>

			<nav className="flex-1 space-y-4">
				<div>
					<NavLink href="/accounts" label="Connected Accounts" />
				</div>

				<div>
					<div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide opacity-40">
						Content
					</div>
					<NavLink href="/dub" label="Dub Video" />
					<NavLink href="/shorts" label="Shorts" />
					<NavLink href="/archive" label="Archive" />
				</div>

				<div>
					<div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide opacity-40">
						Publishing
					</div>
					<NavLink href="/publishing/overview" label="Overview" />
					<NavLink href="/publishing/create" label="Create Post" />
					<NavLink href="/publishing/scheduled" label="Scheduled" />
					<NavLink href="/publishing/analytics" label="Analytics" />
				</div>

				<div>
					<div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide opacity-40">
						Settings
					</div>
					<NavLink href="/settings/api-keys" label="API keys (Claude)" />
					<NavLink href="/settings" label="Service keys (Dub)" />
				</div>

				{user.isAdmin && (
					<div>
						<div className="px-3 pb-1 text-xs font-semibold uppercase tracking-wide opacity-40">
							Admin
						</div>
						<NavLink href="/admin/teams" label="Teams" />
						<NavLink href="/admin/ecosystems" label="Ecosystems" />
						<NavLink href="/admin/members" label="Members" />
					</div>
				)}
			</nav>

			<div className="mt-4 border-t border-black/10 pt-4">
				<div className="px-2 text-sm">{user.name ?? user.email}</div>
				{user.isAdmin && <div className="px-2 text-xs text-primary">Admin</div>}
				<button
					type="button"
					onClick={logout}
					className="mt-2 w-full rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5"
				>
					Sign out
				</button>
			</div>
		</aside>
	);
}
