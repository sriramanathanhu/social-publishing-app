import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
	title: "PeerPost — Social Publishing",
	description: "Multi-user social media publishing & scheduling on PostPeer",
};

export default function RootLayout({
	children,
}: Readonly<{ children: React.ReactNode }>) {
	return (
		<html lang="en">
			<body className="antialiased">{children}</body>
		</html>
	);
}
