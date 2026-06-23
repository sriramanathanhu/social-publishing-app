import "server-only";
import { GoogleAuth } from "google-auth-library";

/**
 * Push a transcript into the corpus: upload the text to the GCS bucket, then
 * trigger a Vertex AI Search (Discovery Engine) incremental import so it becomes
 * searchable and usable for article generation.
 *
 * Requires the service account (GOOGLE_SERVICE_ACCOUNT_JSON) to have:
 *  - Storage Object Admin (or Creator) on GOOGLE_CORPUS_BUCKET (to upload), and
 *  - Discovery Engine Editor on the project (to import).
 */

const BUCKET =
	process.env.GOOGLE_CORPUS_BUCKET || "socialmediaautomation_articlegeneration";

function serviceAccount(): Record<string, unknown> | undefined {
	const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
	if (!raw) return undefined;
	const json = raw.startsWith("{")
		? raw
		: Buffer.from(raw, "base64").toString("utf8");
	return JSON.parse(json);
}

let cachedAuth: GoogleAuth | null = null;
async function token(): Promise<string> {
	if (!cachedAuth) {
		cachedAuth = new GoogleAuth({
			credentials: serviceAccount(),
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
		});
	}
	const client = await cachedAuth.getClient();
	const t = await client.getAccessToken();
	if (!t.token) throw new Error("Could not mint a Google access token");
	return t.token;
}

function location(): string {
	return process.env.GOOGLE_VERTEX_LOCATION?.trim() || "global";
}

function deHost(): string {
	const loc = location();
	return loc === "global"
		? "discoveryengine.googleapis.com"
		: `${loc}-discoveryengine.googleapis.com`;
}

export function corpusConfigured(): boolean {
	return Boolean(
		process.env.GOOGLE_VERTEX_PROJECT &&
			process.env.GOOGLE_SERVICE_ACCOUNT_JSON &&
			BUCKET &&
			(process.env.GOOGLE_VERTEX_DATASTORE || process.env.GOOGLE_VERTEX_ENGINE),
	);
}

/** Upload a UTF-8 text object to the corpus bucket. Returns its gs:// URI. */
export async function uploadToCorpus(
	objectName: string,
	text: string,
): Promise<string> {
	const url = `https://storage.googleapis.com/upload/storage/v1/b/${BUCKET}/o?uploadType=media&name=${encodeURIComponent(objectName)}`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await token()}`,
			"Content-Type": "text/plain; charset=utf-8",
		},
		body: text,
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) {
		throw new Error(
			`GCS upload ${res.status}: ${(await res.text()).slice(0, 200)}`,
		);
	}
	return `gs://${BUCKET}/${objectName}`;
}

async function dataStoreId(): Promise<string> {
	const ds = process.env.GOOGLE_VERTEX_DATASTORE?.trim();
	if (ds) return ds;
	const project = process.env.GOOGLE_VERTEX_PROJECT;
	const engine = process.env.GOOGLE_VERTEX_ENGINE?.trim();
	const r = await fetch(
		`https://${deHost()}/v1/projects/${project}/locations/${location()}/collections/default_collection/engines/${engine}`,
		{ headers: { Authorization: `Bearer ${await token()}` } },
	);
	const d = (await r.json()) as { dataStoreIds?: string[] };
	const id = d.dataStoreIds?.[0];
	if (!id) throw new Error("Could not resolve the Vertex data store id");
	return id;
}

/**
 * Trigger an incremental import of one gs:// file into the data store. Returns
 * the long-running operation name (indexing then continues server-side).
 */
export async function reingestCorpus(gcsUri: string): Promise<string> {
	const project = process.env.GOOGLE_VERTEX_PROJECT;
	const ds = await dataStoreId();
	const url = `https://${deHost()}/v1/projects/${project}/locations/${location()}/collections/default_collection/dataStores/${ds}/branches/0/documents:import`;
	const res = await fetch(url, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${await token()}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			gcsSource: { inputUris: [gcsUri], dataSchema: "content" },
			reconciliationMode: "INCREMENTAL",
		}),
		signal: AbortSignal.timeout(60_000),
	});
	if (!res.ok) {
		throw new Error(
			`Vertex import ${res.status}: ${(await res.text()).slice(0, 200)}`,
		);
	}
	const d = (await res.json()) as { name?: string };
	return d.name ?? "";
}
