"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PLATFORM_LABELS } from "@/lib/platform-fields";

type PlatformStatus = {
	platform: string;
	connected: boolean;
	handle: string | null;
	displayName: string | null;
};

/**
 * The "full set of platforms" grid (req #2 + #5). Each card shows connected
 * state; clicking Connect asks our API for the PostPeer OAuth URL and redirects
 * the browser out to the platform.
 */
export function ConnectPlatforms({
	profileId,
	platforms,
	canConnect,
}: {
	profileId: string;
	platforms: PlatformStatus[];
	canConnect: boolean;
}) {
	const router = useRouter();
	const [pending, setPending] = useState<string | null>(null);
	const [syncing, setSyncing] = useState(false);

	async function refresh() {
		setSyncing(true);
		try {
			await fetch(`/api/profiles/${profileId}/integrations`, {
				method: "POST",
			});
			router.refresh();
		} finally {
			setSyncing(false);
		}
	}

	async function connect(platform: string) {
		setPending(platform);
		try {
			const res = await fetch(`/api/profiles/${profileId}/connect/${platform}`);
			const data = await res.json();
			if (data.url) {
				window.location.href = data.url;
			} else {
				alert(data.error ?? "Could not start connection");
				setPending(null);
			}
		} catch {
			setPending(null);
		}
	}

	return (
		<div className="space-y-3">
			<div className="flex justify-end">
				<button
					type="button"
					onClick={refresh}
					disabled={syncing}
					className="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40"
				>
					{syncing ? "Refreshing…" : "↻ Refresh connections"}
				</button>
			</div>
			<div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
				{platforms.map((p) => (
					<div
						key={p.platform}
						className="flex flex-col gap-2 rounded-lg border border-black/10 p-3"
					>
						<div className="flex items-center justify-between">
							<span className="text-sm font-medium">
								{PLATFORM_LABELS[p.platform] ?? p.platform}
							</span>
							<span
								className={`h-2 w-2 rounded-full ${
									p.connected ? "bg-green-500" : "bg-black/20"
								}`}
							/>
						</div>
						{p.connected ? (
							<span className="truncate text-xs opacity-60">
								{p.handle ?? p.displayName ?? "Connected"}
							</span>
						) : (
							<button
								type="button"
								disabled={!canConnect || pending === p.platform}
								onClick={() => connect(p.platform)}
								className="rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5 disabled:opacity-40"
							>
								{pending === p.platform ? "Redirecting…" : "Connect"}
							</button>
						)}
					</div>
				))}
			</div>
		</div>
	);
}
