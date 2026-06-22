import "server-only";
import { GoogleAuth } from "google-auth-library";

/**
 * Google Vertex AI Search (Discovery Engine) client — retrieval over a managed
 * data store of the user's uploaded corpus. We search for the most relevant
 * passages for a topic, then ground article generation on them.
 *
 * Config (env, all server-side):
 *   GOOGLE_VERTEX_PROJECT        GCP project id
 *   GOOGLE_VERTEX_LOCATION       data-store location: global | us | eu (default global)
 *   GOOGLE_VERTEX_DATASTORE      data store id (query a data store directly), OR
 *   GOOGLE_VERTEX_ENGINE         app/engine id (query an app; takes precedence)
 *   GOOGLE_SERVICE_ACCOUNT_JSON  the service-account key JSON (raw or base64)
 */

function serviceAccount(): Record<string, unknown> | undefined {
	const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
	if (!raw) return undefined;
	const json = raw.startsWith("{")
		? raw
		: Buffer.from(raw, "base64").toString("utf8");
	return JSON.parse(json);
}

let cachedAuth: GoogleAuth | null = null;
function auth(): GoogleAuth {
	if (!cachedAuth) {
		cachedAuth = new GoogleAuth({
			credentials: serviceAccount(),
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
	}
	return cachedAuth;
}

async function accessToken(): Promise<string> {
	const client = await auth().getClient();
	const t = await client.getAccessToken();
	if (!t.token) throw new Error("Could not mint a Google access token");
	return t.token;
}

function location(): string {
	return process.env.GOOGLE_VERTEX_LOCATION?.trim() || "global";
}

function host(): string {
	const loc = location();
	return loc === "global"
		? "discoveryengine.googleapis.com"
		: `${loc}-discoveryengine.googleapis.com`;
}

function servingConfig(): string {
	const project = process.env.GOOGLE_VERTEX_PROJECT;
	const engine = process.env.GOOGLE_VERTEX_ENGINE?.trim();
	const ds = process.env.GOOGLE_VERTEX_DATASTORE?.trim();
	const base = `projects/${project}/locations/${location()}/collections/default_collection`;
	return engine
		? `${base}/engines/${engine}/servingConfigs/default_search`
		: `${base}/dataStores/${ds}/servingConfigs/default_search`;
}

/** Whether Vertex AI Search is fully configured. */
export function vertexConfigured(): boolean {
	return Boolean(
		process.env.GOOGLE_VERTEX_PROJECT &&
			(process.env.GOOGLE_VERTEX_ENGINE ||
				process.env.GOOGLE_VERTEX_DATASTORE) &&
			process.env.GOOGLE_SERVICE_ACCOUNT_JSON,
	);
}

export type CorpusPassage = {
	title: string;
	uri: string;
	snippets: string[];
	segments: string[];
};

/**
 * Search the corpus and return the most relevant passages (snippets +
 * extractive segments) to ground generation on.
 */
export async function searchCorpus(
	query: string,
	opts: { pageSize?: number } = {},
): Promise<CorpusPassage[]> {
	if (!vertexConfigured()) {
		throw new Error(
			"Vertex AI Search isn't configured (GOOGLE_VERTEX_PROJECT / DATASTORE / SERVICE_ACCOUNT_JSON).",
		);
	}
	const url = `https://${host()}/v1/${servingConfig()}:search`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await accessToken()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			query,
			pageSize: opts.pageSize ?? 10,
			contentSearchSpec: {
				snippetSpec: { returnSnippet: true },
				extractiveContentSpec: {
					maxExtractiveAnswerCount: 2,
					maxExtractiveSegmentCount: 2,
				},
			},
		}),
		signal: AbortSignal.timeout(30_000),
	});
	if (!res.ok) {
		throw new Error(
			`Vertex search ${res.status}: ${(await res.text()).slice(0, 300)}`,
		);
	}
	const data = (await res.json()) as {
		results?: {
			document?: {
				derivedStructData?: {
					title?: string;
					link?: string;
					snippets?: { snippet?: string }[];
					extractive_answers?: { content?: string }[];
					extractive_segments?: { content?: string }[];
				};
			};
		}[];
	};
	return (data.results ?? []).map((r) => {
		const d = r.document?.derivedStructData ?? {};
		return {
			title: d.title ?? "",
			uri: d.link ?? "",
			snippets: (d.snippets ?? []).map((s) => s.snippet ?? "").filter(Boolean),
			segments: [
				...(d.extractive_answers ?? []).map((s) => s.content ?? ""),
				...(d.extractive_segments ?? []).map((s) => s.content ?? ""),
			].filter(Boolean),
		};
	});
}
