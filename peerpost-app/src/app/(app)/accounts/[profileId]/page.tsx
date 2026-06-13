import Link from "next/link";
import { notFound } from "next/navigation";
import { ConnectPlatforms } from "@/components/connect-platforms";
import { HttpError } from "@/lib/auth";
import { requirePageUser } from "@/lib/page-auth";
import { getPlatformStatus, getProfile, getTeam } from "@/lib/queries";
import { assertProfileAccess } from "@/lib/rbac";

type Props = { params: Promise<{ profileId: string }> };

export default async function ProfilePlatformsPage({ params }: Props) {
	const { profileId } = await params;
	const user = await requirePageUser();

	try {
		await assertProfileAccess(user, profileId);
	} catch (e) {
		if (e instanceof HttpError) notFound();
		throw e;
	}

	const profile = await getProfile(profileId);
	if (!profile) notFound();
	const [platforms, team] = await Promise.all([
		getPlatformStatus(profileId),
		profile.teamId ? getTeam(profile.teamId) : Promise.resolve(null),
	]);

	return (
		<div className="space-y-6">
			<div>
				<Link
					href={`/accounts${team ? `?team=${team.id}` : ""}`}
					className="text-xs opacity-60 hover:underline"
				>
					← {team?.name ?? "Accounts"}
				</Link>
				<h1 className="text-xl font-semibold">{profile.name}</h1>
				{profile.description && (
					<p className="text-sm opacity-60">{profile.description}</p>
				)}
			</div>

			<section>
				<h2 className="mb-3 text-sm font-semibold uppercase tracking-wide opacity-50">
					Platforms
				</h2>
				<ConnectPlatforms
					profileId={profileId}
					platforms={platforms}
					canConnect
				/>
			</section>

			<p className="text-xs opacity-50">
				Connect each platform here, then publish from{" "}
				<Link href="/publishing/create" className="underline">
					Publishing → Create Post
				</Link>
				.
			</p>
		</div>
	);
}
