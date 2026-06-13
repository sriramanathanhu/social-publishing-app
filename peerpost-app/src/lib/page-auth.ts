import { redirect } from "next/navigation";
import { type AppUser, getCurrentUser } from "@/lib/auth";
import { isAdmin } from "@/lib/rbac";

/**
 * RSC page guards. `redirect()` throws, so these narrow the return to a
 * non-null user. Replaces the repeated getCurrentUser()+redirect boilerplate.
 */

export async function requirePageUser(): Promise<AppUser> {
	const user = await getCurrentUser();
	if (!user) redirect("/");
	return user;
}

export async function requireAdminPage(): Promise<AppUser> {
	const user = await requirePageUser();
	if (!isAdmin(user)) redirect("/accounts");
	return user;
}
