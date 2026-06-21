"use client";

import { useEffect, useState } from "react";

/**
 * Light/dark switch. Toggles the `.dark` class on <html> and persists the choice
 * to localStorage (read back before paint by the bootstrap script in the root
 * layout, so there's no flash on reload).
 */
export function ThemeToggle() {
	const [dark, setDark] = useState(false);

	// Reflect whatever the pre-paint script already applied.
	useEffect(() => {
		setDark(document.documentElement.classList.contains("dark"));
	}, []);

	function toggle() {
		const next = !dark;
		setDark(next);
		document.documentElement.classList.toggle("dark", next);
		try {
			localStorage.theme = next ? "dark" : "light";
		} catch {
			/* localStorage may be unavailable (private mode) — non-fatal */
		}
	}

	return (
		<button
			type="button"
			onClick={toggle}
			aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
			className="flex w-full items-center justify-center gap-2 rounded-md border border-black/15 px-3 py-1.5 text-sm hover:bg-black/5"
		>
			<span aria-hidden>{dark ? "☀️" : "🌙"}</span>
			{dark ? "Light mode" : "Dark mode"}
		</button>
	);
}
