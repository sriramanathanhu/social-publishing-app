import { redirect } from "next/navigation";
import { cn } from "@/lib/utils";
import { getCurrentUser } from "@/lib/auth";

const ERROR_MESSAGES: Record<string, string> = {
	auth_failed: "Sign-in failed at the auth server. Please try again.",
	missing_auth_code: "No authorization code returned.",
	state_mismatch: "Security check failed (state mismatch). Please retry.",
	token_exchange_failed: "Could not exchange the authorization code.",
	callback_error: "Unexpected error during sign-in.",
};

/**
 * Landing page. If signed in (Nandi SSO session valid + user provisioned),
 * show a minimal dashboard entry; otherwise show the Nandi sign-in link.
 */
export default async function Home({
	searchParams,
}: {
	searchParams: Promise<{ error?: string }>;
}) {
	const user = await getCurrentUser();
	const { error } = await searchParams;

	// Signed-in users go straight to the dashboard.
	if (user) redirect("/accounts");

	return (
		<div className="grid min-h-screen place-items-center p-8">
			<main className="flex w-full max-w-md flex-col items-center gap-8">
				<h1 className="text-2xl font-semibold">PeerPost</h1>
				<p className="text-center text-sm opacity-70">
					Multi-user social publishing &amp; scheduling.
				</p>

				{error && (
					<p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
						{ERROR_MESSAGES[error] ?? "Sign-in error."}
					</p>
				)}

				<a
					href="/api/auth/login"
					className={cn(
						"flex h-11 items-center justify-center rounded-full px-6",
						"bg-primary text-white text-sm font-medium",
					)}
				>
					Sign in with Nandi
				</a>
			</main>
		</div>
	);
}
