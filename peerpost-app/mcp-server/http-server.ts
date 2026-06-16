/**
 * PeerPost MCP server — Streamable HTTP transport + an OAuth handshake that
 * wraps a PeerPost API key (the access_token IS the key). Mirrors the proven
 * smassets pattern so Claude's "Connect" flow works. Auth scopes every tool to
 * the key owner's ecosystems + approval.
 */
import { createHash, randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import { type AuthContext, authStorage, validateApiKey } from "./auth";
import { mintApiKey, resolveUserFromSession } from "./sso";
import { createMcpServer } from "./tools";

const PORT = Number.parseInt(process.env.MCP_PORT ?? "3010", 10);
const PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? "https://post-dev.kailasa.ai";
// Where the app (and its registered Nandi callback) live.
const APP_BASE = process.env.NEXT_BASE_URL ?? PUBLIC_URL;
const NANDI_URL = process.env.NEXT_AUTH_URL ?? "";
const NANDI_CLIENT_ID = process.env.NEXT_AUTH_CLIENT_ID ?? "";

function parseCookies(header: string | undefined): Record<string, string> {
	const out: Record<string, string> = {};
	if (!header) return out;
	for (const part of header.split(";")) {
		const i = part.indexOf("=");
		if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
	}
	return out;
}

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
	cors({
		origin: true,
		methods: ["GET", "POST", "DELETE", "OPTIONS"],
		allowedHeaders: ["Content-Type", "Authorization", "mcp-session-id"],
		exposedHeaders: ["mcp-session-id"],
	}),
);

// ── OAuth (API-key-backed) ───────────────────────────────────────────────────
type AuthCode = {
	apiKey: string;
	codeChallenge: string;
	redirectUri: string;
	expiresAt: number;
};
const authCodes = new Map<string, AuthCode>();
// Pending SSO logins: maps our `mcp:<id>` state → Claude's OAuth params, kept
// while the user round-trips through Nandi login.
type PendingLogin = {
	claudeRedirect: string;
	codeChallenge: string;
	claudeState: string;
	expiresAt: number;
};
const pendingLogins = new Map<string, PendingLogin>();
setInterval(
	() => {
		const now = Date.now();
		for (const [c, d] of authCodes) if (d.expiresAt < now) authCodes.delete(c);
		for (const [c, d] of pendingLogins)
			if (d.expiresAt < now) pendingLogins.delete(c);
	},
	5 * 60 * 1000,
);

app.post("/oauth/register", (req, res) => {
	const clientId = `pp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
	res.status(201).json({
		client_id: clientId,
		client_name: req.body?.client_name ?? "MCP Client",
		redirect_uris: req.body?.redirect_uris ?? [],
		grant_types: ["authorization_code"],
		response_types: ["code"],
		token_endpoint_auth_method: "none",
	});
});

app.get("/.well-known/oauth-authorization-server", (_req, res) => {
	res.json({
		issuer: PUBLIC_URL,
		authorization_endpoint: `${PUBLIC_URL}/authorize`,
		token_endpoint: `${PUBLIC_URL}/oauth/token`,
		registration_endpoint: `${PUBLIC_URL}/oauth/register`,
		token_endpoint_auth_methods_supported: ["none"],
		grant_types_supported: ["authorization_code"],
		response_types_supported: ["code"],
		code_challenge_methods_supported: ["S256"],
		scopes_supported: ["read_write"],
	});
});

app.get("/.well-known/oauth-protected-resource", (_req, res) => {
	res.json({
		resource: `${PUBLIC_URL}/mcp`,
		authorization_servers: [PUBLIC_URL],
		scopes_supported: ["read_write"],
	});
});

/**
 * Authorize via Nandi SSO (no API key). We stash Claude's OAuth params, set the
 * CSRF cookie the app's Nandi callback expects, and redirect the user to Nandi
 * sign-in pointed at the app's ALREADY-REGISTERED callback. The `mcp:` state
 * tells that callback to bounce back to /oauth/mcp-finish here.
 */
app.get("/authorize", (req, res) => {
	const { response_type, redirect_uri, code_challenge, state } =
		req.query as Record<string, string>;
	if (response_type !== "code" || !redirect_uri || !code_challenge || !state) {
		res.status(400).send("Invalid OAuth request");
		return;
	}
	const login = randomUUID();
	pendingLogins.set(login, {
		claudeRedirect: redirect_uri,
		codeChallenge: code_challenge,
		claudeState: state,
		expiresAt: Date.now() + 10 * 60 * 1000,
	});

	const nandiState = `mcp:${login}`;
	res.cookie("nandi_oauth_state", nandiState, {
		httpOnly: true,
		sameSite: "lax",
		secure: true,
		path: "/",
		maxAge: 10 * 60 * 1000,
	});

	const url = new URL(`${NANDI_URL}/oauth/authorize`);
	url.searchParams.set("client_id", NANDI_CLIENT_ID);
	url.searchParams.set("redirect_uri", `${APP_BASE}/api/auth/callback`);
	url.searchParams.set("state", nandiState);
	res.redirect(url.toString());
});

/**
 * The app's Nandi callback bounces here (?login=...) after setting the session
 * cookie. We resolve the signed-in user, mint an API key as the access_token,
 * and hand Claude its authorization code.
 */
app.get("/oauth/mcp-finish", async (req, res) => {
	const login = req.query.login as string | undefined;
	const pending = login ? pendingLogins.get(login) : undefined;
	if (!pending || pending.expiresAt < Date.now()) {
		res.status(400).send("Login expired — please reconnect from Claude.");
		return;
	}
	pendingLogins.delete(login as string);

	const sessionToken = parseCookies(req.headers.cookie).nandi_session_token;
	if (!sessionToken) {
		res.status(401).send("No PeerPost session — please sign in and retry.");
		return;
	}
	try {
		const userId = await resolveUserFromSession(sessionToken);
		if (!userId) {
			res.status(401).send("Could not resolve your PeerPost account.");
			return;
		}
		const apiKey = await mintApiKey(userId);
		const code = randomUUID();
		authCodes.set(code, {
			apiKey,
			codeChallenge: pending.codeChallenge,
			redirectUri: pending.claudeRedirect,
			expiresAt: Date.now() + 10 * 60 * 1000,
		});
		const url = new URL(pending.claudeRedirect);
		url.searchParams.set("code", code);
		url.searchParams.set("state", pending.claudeState);
		res.redirect(url.toString());
	} catch (e) {
		console.error("mcp-finish error:", e);
		res.status(500).send("Authorization failed. Please try again.");
	}
});

app.post("/oauth/token", async (req, res) => {
	if (req.body.grant_type !== "authorization_code") {
		res.status(400).json({ error: "unsupported_grant_type" });
		return;
	}
	const { code, code_verifier } = req.body;
	const ac = code ? authCodes.get(code) : undefined;
	if (!ac || ac.expiresAt < Date.now()) {
		res.status(400).json({ error: "invalid_grant" });
		return;
	}
	authCodes.delete(code);
	const challenge = createHash("sha256")
		.update(code_verifier ?? "")
		.digest("base64url");
	if (challenge !== ac.codeChallenge) {
		res
			.status(400)
			.json({ error: "invalid_grant", error_description: "PKCE failed" });
		return;
	}
	try {
		await validateApiKey(ac.apiKey);
		res.json({
			access_token: ac.apiKey,
			token_type: "Bearer",
			scope: "read_write",
		});
	} catch (e) {
		res.status(401).json({
			error: "invalid_grant",
			error_description: e instanceof Error ? e.message : "Auth failed",
		});
	}
});

// ── MCP transport ────────────────────────────────────────────────────────────
async function authenticate(
	req: express.Request,
	res: express.Response,
): Promise<AuthContext | null> {
	const h = req.headers.authorization;
	if (!h?.startsWith("Bearer ")) {
		res.status(401).json({ error: "Missing Bearer token" });
		return null;
	}
	try {
		return await validateApiKey(h.slice(7).trim());
	} catch (e) {
		res
			.status(401)
			.json({ error: e instanceof Error ? e.message : "Auth failed" });
		return null;
	}
}

type Session = {
	transport: StreamableHTTPServerTransport;
	auth: AuthContext;
	lastActivity: number;
};
const sessions = new Map<string, Session>();
setInterval(() => {
	const now = Date.now();
	for (const [id, s] of sessions) {
		if (now - s.lastActivity > 24 * 60 * 60 * 1000) {
			try {
				s.transport.close();
			} catch {}
			sessions.delete(id);
		}
	}
}, 60_000);

app.post("/mcp", async (req, res) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	const method = req.body?.method ?? "batch";

	const existing = sessionId ? sessions.get(sessionId) : undefined;
	if (existing) {
		existing.lastActivity = Date.now();
		authStorage.run(existing.auth, async () => {
			await existing.transport.handleRequest(req, res, req.body);
		});
		return;
	}
	if (sessionId && method !== "initialize") {
		res.status(200).json({
			jsonrpc: "2.0",
			error: { code: -32001, message: "Session expired. Send initialize." },
			id: req.body?.id ?? null,
		});
		return;
	}

	const auth = await authenticate(req, res);
	if (!auth) return;

	const transport = new StreamableHTTPServerTransport({
		sessionIdGenerator: () => randomUUID(),
	});
	const server = createMcpServer();
	authStorage.run(auth, async () => {
		await server.connect(transport);
		await transport.handleRequest(req, res, req.body);
		const id = transport.sessionId;
		if (id) sessions.set(id, { transport, auth, lastActivity: Date.now() });
	});
});

app.get("/mcp", async (req, res) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	const s = sessionId ? sessions.get(sessionId) : undefined;
	if (!s) {
		res.status(400).json({ error: "Invalid or missing session ID" });
		return;
	}
	s.lastActivity = Date.now();
	const keepalive = setInterval(() => {
		if (!res.writableEnded) {
			try {
				res.write(": keepalive\n\n");
			} catch {
				clearInterval(keepalive);
			}
		} else clearInterval(keepalive);
	}, 30_000);
	res.on("close", () => clearInterval(keepalive));
	authStorage.run(s.auth, async () => {
		await s.transport.handleRequest(req, res);
	});
});

app.delete("/mcp", async (req, res) => {
	const sessionId = req.headers["mcp-session-id"] as string | undefined;
	if (sessionId && sessions.has(sessionId)) {
		try {
			sessions.get(sessionId)?.transport.close();
		} catch {}
		sessions.delete(sessionId);
	}
	res.status(200).json({ status: "ok" });
});

app.get("/health", (_req, res) =>
	res.json({ ok: true, service: "peerpost-mcp" }),
);

app.listen(PORT, () => {
	console.error(
		`[peerpost-mcp] listening on :${PORT} (public ${PUBLIC_URL}/mcp)`,
	);
});
