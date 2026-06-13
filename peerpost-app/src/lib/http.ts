import { ZodError } from "zod";
import { HttpError } from "@/lib/auth";

/**
 * Wraps a route handler, converting HttpError / ZodError into clean JSON
 * responses so individual handlers stay focused on logic.
 */
export function route<Args extends unknown[]>(
	handler: (...args: Args) => Promise<Response>,
) {
	return async (...args: Args): Promise<Response> => {
		try {
			return await handler(...args);
		} catch (err) {
			if (err instanceof HttpError) {
				return Response.json({ error: err.message }, { status: err.status });
			}
			if (err instanceof ZodError) {
				return Response.json(
					{ error: "Validation failed", details: err.flatten() },
					{ status: 422 },
				);
			}
			console.error("Unhandled route error:", err);
			return Response.json({ error: "Internal Server Error" }, { status: 500 });
		}
	};
}
