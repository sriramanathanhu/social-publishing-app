import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";

/**
 * Google Drive access via a SERVICE ACCOUNT (read-only). Provide the key by
 * either GOOGLE_DRIVE_SA_FILE (path to the JSON key — preferred, avoids env
 * escaping of the multi-line private key) or GOOGLE_DRIVE_SA_JSON (inline JSON).
 * Share folders/files with the service account's client_email (Viewer) and the
 * MCP can list + download them — so a folder link expands to every file inside.
 */

type ServiceAccount = { client_email: string; private_key: string };

function loadSA(): ServiceAccount | null {
	let raw = process.env.GOOGLE_DRIVE_SA_JSON;
	const file = process.env.GOOGLE_DRIVE_SA_FILE;
	if (!raw && file) {
		try {
			raw = readFileSync(file, "utf8");
		} catch {
			return null;
		}
	}
	if (!raw) return null;
	try {
		const j = JSON.parse(raw);
		if (j.client_email && j.private_key) return j;
	} catch {
		// fall through
	}
	return null;
}

export const driveEnabled = (): boolean => loadSA() !== null;

const b64url = (s: string) => Buffer.from(s).toString("base64url");

let cached: { token: string; exp: number } | null = null;

async function accessToken(): Promise<string> {
	const sa = loadSA();
	if (!sa) throw new Error("Google Drive is not configured on the server.");
	if (cached && cached.exp > Date.now() + 60_000) return cached.token;

	const now = Math.floor(Date.now() / 1000);
	const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
	const claims = b64url(
		JSON.stringify({
			iss: sa.client_email,
			scope: "https://www.googleapis.com/auth/drive.readonly",
			aud: "https://oauth2.googleapis.com/token",
			iat: now,
			exp: now + 3600,
		}),
	);
	const signer = createSign("RSA-SHA256");
	signer.update(`${header}.${claims}`);
	signer.end();
	const sig = signer.sign(sa.private_key).toString("base64url");
	const jwt = `${header}.${claims}.${sig}`;

	const res = await fetch("https://oauth2.googleapis.com/token", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
			assertion: jwt,
		}),
	});
	if (!res.ok) throw new Error(`Drive auth failed (HTTP ${res.status})`);
	const d = (await res.json()) as { access_token: string; expires_in?: number };
	cached = {
		token: d.access_token,
		exp: Date.now() + (d.expires_in ?? 3600) * 1000,
	};
	return cached.token;
}

export type DriveTarget = { kind: "folder" | "file"; id: string };

/** Recognise a Drive folder or file URL and pull out its id. */
export function parseDriveUrl(url: string): DriveTarget | null {
	const folder = url.match(/folders\/([\w-]+)/);
	if (folder) return { kind: "folder", id: folder[1] };
	const file = url.match(/\/file\/d\/([\w-]+)/) ?? url.match(/[?&]id=([\w-]+)/);
	if (file) return { kind: "file", id: file[1] };
	return null;
}

export type DriveFile = { id: string; name: string; mimeType: string };

/** List image/video files directly inside a folder (sorted by name). */
export async function listFolderMedia(folderId: string): Promise<DriveFile[]> {
	const token = await accessToken();
	const files: DriveFile[] = [];
	let pageToken: string | undefined;
	do {
		const params = new URLSearchParams({
			q: `'${folderId}' in parents and trashed = false`,
			fields: "nextPageToken,files(id,name,mimeType)",
			pageSize: "1000",
			supportsAllDrives: "true",
			includeItemsFromAllDrives: "true",
			orderBy: "name",
		});
		if (pageToken) params.set("pageToken", pageToken);
		const res = await fetch(
			`https://www.googleapis.com/drive/v3/files?${params}`,
			{ headers: { Authorization: `Bearer ${token}` } },
		);
		if (!res.ok)
			throw new Error(`Drive folder list failed (HTTP ${res.status})`);
		const d = (await res.json()) as {
			files?: DriveFile[];
			nextPageToken?: string;
		};
		for (const f of d.files ?? []) {
			if (/^(image|video)\//.test(f.mimeType)) files.push(f);
		}
		pageToken = d.nextPageToken;
	} while (pageToken);
	return files;
}

/** Download one Drive file's bytes + mime + name. */
export async function downloadDriveFile(
	fileId: string,
): Promise<{ bytes: Buffer; mimeType: string; name: string }> {
	const token = await accessToken();
	const metaRes = await fetch(
		`https://www.googleapis.com/drive/v3/files/${fileId}?fields=name,mimeType&supportsAllDrives=true`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!metaRes.ok) {
		throw new Error(
			`Drive file not accessible (HTTP ${metaRes.status}) — is it shared with the service account?`,
		);
	}
	const meta = (await metaRes.json()) as { name: string; mimeType: string };
	const res = await fetch(
		`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`,
		{ headers: { Authorization: `Bearer ${token}` } },
	);
	if (!res.ok) throw new Error(`Drive download failed (HTTP ${res.status})`);
	return {
		bytes: Buffer.from(await res.arrayBuffer()),
		mimeType: meta.mimeType,
		name: meta.name,
	};
}
