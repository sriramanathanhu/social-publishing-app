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
import { createMcpServer } from "./tools";

const PORT = Number.parseInt(process.env.MCP_PORT ?? "3010", 10);
const PUBLIC_URL = process.env.MCP_PUBLIC_URL ?? "https://post-dev.kailasa.ai";

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
setInterval(
	() => {
		const now = Date.now();
		for (const [c, d] of authCodes) if (d.expiresAt < now) authCodes.delete(c);
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

app.get("/authorize", (req, res) => {
	const { response_type, redirect_uri, code_challenge, state } =
		req.query as Record<string, string>;
	if (response_type !== "code" || !redirect_uri || !code_challenge || !state) {
		res.status(400).send("Invalid OAuth request");
		return;
	}
	res.type("html").send(`<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect PeerPost</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
.card{background:#1e293b;padding:2rem;border-radius:12px;max-width:420px;width:90%}
h1{font-size:1.15rem;margin:0 0 .25rem} p{color:#94a3b8;font-size:.85rem;margin:0 0 1.25rem}
input{width:100%;padding:.7rem;border-radius:8px;border:1px solid #334155;background:#0f172a;color:#fff;box-sizing:border-box}
button{width:100%;margin-top:1rem;padding:.7rem;border:0;border-radius:8px;background:#4f46e5;color:#fff;font-weight:600;cursor:pointer}
.err{color:#f87171;font-size:.8rem;margin-top:.6rem;display:none} a{color:#818cf8}</style></head>
<body><div class="card"><h1>Connect Claude to PeerPost</h1>
<p>Paste a PeerPost API key. Generate one under Settings → API keys.</p>
<form id="f"><input id="k" type="password" placeholder="pp_..." autocomplete="off" required>
<button id="b" type="submit">Authorize</button><div class="err" id="e"></div></form></div>
<script>
const f=document.getElementById('f');
f.addEventListener('submit',async(ev)=>{ev.preventDefault();const b=document.getElementById('b');b.disabled=true;b.textContent='Authorizing…';
const body=new URLSearchParams({api_key:document.getElementById('k').value,redirect_uri:${JSON.stringify(redirect_uri)},code_challenge:${JSON.stringify(code_challenge)},state:${JSON.stringify(state)}});
const r=await fetch('/authorize',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body});
const d=await r.json().catch(()=>null);
if(d&&d.redirect_to){window.location.href=d.redirect_to;return;}
const e=document.getElementById('e');e.textContent=(d&&d.error_description)||'Authorization failed';e.style.display='block';b.disabled=false;b.textContent='Authorize';});
</script></body></html>`);
});

app.post("/authorize", async (req, res) => {
	const { api_key, redirect_uri, code_challenge, state } = req.body;
	if (!api_key || !redirect_uri || !code_challenge || !state) {
		res.status(400).json({ error: "invalid_request" });
		return;
	}
	try {
		await validateApiKey(api_key);
		const code = randomUUID();
		authCodes.set(code, {
			apiKey: api_key,
			codeChallenge: code_challenge,
			redirectUri: redirect_uri,
			expiresAt: Date.now() + 10 * 60 * 1000,
		});
		const url = new URL(redirect_uri);
		url.searchParams.set("code", code);
		url.searchParams.set("state", state);
		res.json({ redirect_to: url.toString() });
	} catch (e) {
		res.status(401).json({
			error: "access_denied",
			error_description: e instanceof Error ? e.message : "Invalid API key",
		});
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
