"use client";

import { useRouter } from "next/navigation";

export function LogoutButton() {
	const router = useRouter();
	async function logout() {
		await fetch("/api/auth/logout", { method: "POST" });
		router.push("/");
		router.refresh();
	}
	return (
		<button
			type="button"
			onClick={logout}
			className="rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5"
		>
			Sign out
		</button>
	);
}
