import { cookies } from "next/headers";
import { SESSION_COOKIE, STATE_COOKIE } from "@/lib/nandi";

/** Clears local session cookies. */
export async function POST() {
	const cookieStore = await cookies();
	cookieStore.delete(SESSION_COOKIE);
	cookieStore.delete(STATE_COOKIE);
	return Response.json({ ok: true });
}
