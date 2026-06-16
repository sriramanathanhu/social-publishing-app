"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ManageAccounts } from "@/components/manage-accounts";
import { PLATFORM_LABELS } from "@/lib/platform-fields";

type Account = {
	accountId: string;
	handle: string | null;
	displayName: string | null;
	active: boolean;
};
type PlatformStatus = {
	platform: string;
	connected: boolean;
	activeCount: number;
	accounts: Account[];
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
	const [removing, setRemoving] = useState<string | null>(null);
	const [managing, setManaging] = useState<PlatformStatus | null>(null);

	async function disconnect(accountId: string, label: string) {
		if (
			!confirm(
				`Disconnect ${label}? It will no longer be available for posting.`,
			)
		)
			return;
		setRemoving(accountId);
		try {
			await fetch(`/api/profiles/${profileId}/integrations/${accountId}`, {
				method: "DELETE",
			});
			router.refresh();
		} finally {
			setRemoving(null);
		}
	}

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
								{p.accounts.length > 1 && (
									<span className="ml-1 rounded-full bg-black/10 px-1.5 text-[10px]">
										{p.accounts.length}
									</span>
								)}
							</span>
							<span
								className={`h-2 w-2 rounded-full ${
									p.connected ? "bg-green-500" : "bg-black/20"
								}`}
							/>
						</div>
						{p.connected ? (
							<div className="flex flex-col gap-1">
								{/* Many accounts (e.g. 200 FB pages): summarise + manage. */}
								{p.accounts.length > 4 ? (
									<span className="text-xs opacity-60">
										{p.activeCount} active of {p.accounts.length} connected
									</span>
								) : (
									p.accounts.map((a) => {
										const label = a.handle ?? a.displayName ?? "Connected";
										return (
											<div
												key={a.accountId}
												className="group flex items-center justify-between gap-1"
											>
												<span
													className={`truncate text-xs ${a.active ? "opacity-60" : "opacity-30 line-through"}`}
												>
													{label}
												</span>
												{canConnect && (
													<button
														type="button"
														title="Disconnect this account"
														disabled={removing === a.accountId}
														onClick={() => disconnect(a.accountId, label)}
														className="shrink-0 text-xs text-red-600 opacity-0 hover:underline group-hover:opacity-100 disabled:opacity-40"
													>
														{removing === a.accountId ? "…" : "✕"}
													</button>
												)}
											</div>
										);
									})
								)}
								{canConnect && (
									<div className="mt-1 flex items-center gap-3 text-[11px]">
										{p.accounts.length > 1 && (
											<button
												type="button"
												onClick={() => setManaging(p)}
												className="text-primary hover:underline"
											>
												Manage accounts
											</button>
										)}
										<button
											type="button"
											disabled={pending === p.platform}
											onClick={() => connect(p.platform)}
											className="text-primary hover:underline disabled:opacity-40"
										>
											+ Connect another
										</button>
									</div>
								)}
							</div>
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

			{managing && (
				<ManageAccounts
					profileId={profileId}
					platform={managing.platform}
					label={PLATFORM_LABELS[managing.platform] ?? managing.platform}
					accounts={managing.accounts}
					onClose={() => setManaging(null)}
				/>
			)}
		</div>
	);
}
