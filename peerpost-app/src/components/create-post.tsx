"use client";

import { useState } from "react";
import { Composer } from "@/components/composer";

type ProfileWithAccounts = {
	id: string;
	name: string;
	teamName: string;
	accounts: { platform: string; accountId: string; handle: string | null }[];
};

/** Profile picker + composer for the Create Post page. */
export function CreatePost({ profiles }: { profiles: ProfileWithAccounts[] }) {
	const [profileId, setProfileId] = useState(profiles[0]?.id ?? "");
	const active = profiles.find((p) => p.id === profileId);

	if (profiles.length === 0) {
		return (
			<p className="rounded-lg border border-black/10 p-4 text-sm opacity-60">
				No ecosystems available. Create an ecosystem and connect platforms under
				Connected Accounts first.
			</p>
		);
	}

	return (
		<div className="space-y-4">
			<div>
				<label className="mb-1 block text-xs font-medium opacity-60">
					Ecosystem
				</label>
				<select
					value={profileId}
					onChange={(e) => setProfileId(e.target.value)}
					className="w-full rounded-md border border-black/15 px-3 py-2 text-sm"
				>
					{profiles.map((p) => (
						<option key={p.id} value={p.id}>
							{p.teamName} › {p.name} ({p.accounts.length} connected)
						</option>
					))}
				</select>
			</div>

			{active && (
				<Composer
					key={active.id}
					profileId={active.id}
					accounts={active.accounts}
					canPost
				/>
			)}
		</div>
	);
}
