"use client";

import { usePathname } from "next/navigation";

/**
 * Most app pages read best centred in a narrow column. The Articles workspace
 * (list + full-width editor + publishing) needs the full width and height, so
 * it opts out of the centred container here.
 */
export function ContentWidth({ children }: { children: React.ReactNode }) {
	const path = usePathname();
	const fullBleed =
		path?.startsWith("/articles") || path?.startsWith("/transcribe");
	return (
		<div className={fullBleed ? "h-full" : "mx-auto max-w-4xl p-8"}>
			{children}
		</div>
	);
}
