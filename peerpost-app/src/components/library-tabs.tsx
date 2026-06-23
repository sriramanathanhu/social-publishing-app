"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const TABS = [
	{ href: "/library/photo", label: "Photo" },
	{ href: "/library/video", label: "Video" },
	{ href: "/library/quotes", label: "Quotes" },
	{ href: "/library/articles", label: "Articles" },
	{ href: "/library/transcript", label: "Transcript" },
];

export function LibraryTabs() {
	const pathname = usePathname();
	return (
		<nav className="mt-2 flex flex-wrap gap-1">
			{TABS.map((t) => {
				const active = pathname.startsWith(t.href);
				return (
					<Link
						key={t.href}
						href={t.href}
						className={cn(
							"rounded-lg px-3 py-1.5 text-sm",
							active
								? "bg-slate-900 text-white"
								: "text-slate-600 hover:bg-slate-100",
						)}
					>
						{t.label}
					</Link>
				);
			})}
		</nav>
	);
}
