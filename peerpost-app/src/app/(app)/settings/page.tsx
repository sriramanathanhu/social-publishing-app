import { ApiKeysForm } from "@/components/api-keys-form";
import { CookiesForm } from "@/components/cookies-form";
import { getUserCookiesPresence, getUserKeyPresence } from "@/lib/api-keys";
import { requirePageUser } from "@/lib/page-auth";

/** Settings: bring-your-own API keys for the dubbing pipeline. */
export default async function SettingsPage() {
	const user = await requirePageUser();
	const [presence, cookiesPresent] = await Promise.all([
		getUserKeyPresence(user.id),
		getUserCookiesPresence(user.id),
	]);

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">Settings</h1>
				<p className="mt-1 text-sm opacity-60">
					Your API keys power the dubbing pipeline. They are encrypted at rest
					and used only while a dub job runs — never shared or shown again.
				</p>
			</div>
			<ApiKeysForm presence={presence} />
			<CookiesForm present={cookiesPresent} />
		</div>
	);
}
