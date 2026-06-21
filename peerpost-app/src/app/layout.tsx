import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "PeerPost — Social Publishing",
	description: "Multi-user social media publishing & scheduling on PostPeer",
};

// Applied before paint to avoid a light/dark flash: use the saved choice, else
// follow the OS preference.
const themeScript = `(function(){try{var t=localStorage.theme;if(t==="dark"||(!t&&window.matchMedia("(prefers-color-scheme: dark)").matches)){document.documentElement.classList.add("dark")}}catch(e){}})()`;

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en" suppressHydrationWarning>
			<head>
				{/* biome-ignore lint/security/noDangerouslySetInnerHtml: tiny inline theme bootstrap, no user input */}
				<script dangerouslySetInnerHTML={{ __html: themeScript }} />
			</head>
			<body className="antialiased">{children}</body>
		</html>
	);
}
