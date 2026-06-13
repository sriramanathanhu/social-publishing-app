import { desc, eq } from "drizzle-orm";
import { ApiKeysManager } from "@/components/api-keys-manager";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { requirePageUser } from "@/lib/page-auth";

const MCP_URL = process.env.NEXT_BASE_URL
	? `${process.env.NEXT_BASE_URL}/mcp`
	: "/mcp";

/** Settings → API keys: generate keys for connecting Claude via MCP. */
export default async function ApiKeysPage() {
	const user = await requirePageUser();

	const keys = await db
		.select({
			id: apiKeys.id,
			label: apiKeys.label,
			createdAt: apiKeys.createdAt,
			lastUsedAt: apiKeys.lastUsedAt,
		})
		.from(apiKeys)
		.where(eq(apiKeys.userId, user.id))
		.orderBy(desc(apiKeys.createdAt));

	return (
		<div className="space-y-5">
			<div>
				<h1 className="text-xl font-semibold">API keys (Claude / MCP)</h1>
				<p className="text-sm opacity-60">
					Generate a key to connect Claude to PeerPost. In Claude, add a custom
					connector pointing at <code className="text-xs">{MCP_URL}</code> and
					paste the key when prompted. Tools act with your access and approval.
				</p>
			</div>

			<ApiKeysManager
				keys={keys.map((k) => ({
					...k,
					createdAt: k.createdAt.toISOString(),
					lastUsedAt: k.lastUsedAt ? k.lastUsedAt.toISOString() : null,
				}))}
			/>
		</div>
	);
}
