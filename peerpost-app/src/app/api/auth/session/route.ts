import { getCurrentUser } from "@/lib/auth";

/** Returns the current local user (JIT-provisioned), or 401 if not signed in. */
export async function GET() {
	const user = await getCurrentUser();
	if (!user) {
		return new Response(JSON.stringify({ authenticated: false }), {
			status: 401,
			headers: { "Content-Type": "application/json" },
		});
	}

	return Response.json({
		authenticated: true,
		user: {
			id: user.id,
			email: user.email,
			name: user.name,
			role: user.role,
		},
	});
}
