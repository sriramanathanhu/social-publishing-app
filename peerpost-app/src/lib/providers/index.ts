import { postpeerProvider } from "@/lib/providers/postpeer";
import type { ProviderName, PublishProvider } from "@/lib/providers/types";
import { zernioProvider } from "@/lib/providers/zernio";

const PROVIDERS: Record<ProviderName, PublishProvider> = {
	postpeer: postpeerProvider,
	zernio: zernioProvider,
};

/** Resolve the publish client for a provider. */
export function getProvider(name: ProviderName): PublishProvider {
	const p = PROVIDERS[name];
	if (!p) throw new Error(`Unknown provider: ${name}`);
	return p;
}

export type { ProviderName, PublishProvider } from "@/lib/providers/types";
