import { desc, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { dubJobs, shortsJobs, userApiKeys, users } from "@/db/schema";

/**
 * Admin diagnostics: turn the failure text already stored on dub/shorts jobs
 * into a classified, per-user picture, so an admin can tell at a glance whether
 * an issue is a user's API key, the source video, or the server — without
 * reading raw logs.
 */

export type IssueCategory =
	| "key_credits"
	| "key_invalid"
	| "key_rate"
	| "source"
	| "render"
	| "timeout"
	| "other";

export const CATEGORY_LABEL: Record<
	IssueCategory,
	{ label: string; fix: string; server: boolean }
> = {
	key_credits: {
		label: "API key — out of credits",
		fix: "User must top up / add billing to their key (Settings → Service keys).",
		server: false,
	},
	key_invalid: {
		label: "API key — invalid",
		fix: "User must re-enter a valid key (Settings → Service keys).",
		server: false,
	},
	key_rate: {
		label: "API key — rate limit / quota",
		fix: "Key hit its rate/quota — wait, or upgrade the plan.",
		server: false,
	},
	source: {
		label: "Source / cookies",
		fix: "Blocked or unusable source: re-export signed-in cookies, or the video is private / has no speech.",
		server: false,
	},
	render: {
		label: "Render failure (server)",
		fix: "ffmpeg/clip render failed — often resource contention under concurrent load.",
		server: true,
	},
	timeout: {
		label: "Timeout / overload (server)",
		fix: "A stage exceeded its time budget — slow network or server under load.",
		server: true,
	},
	other: {
		label: "Other",
		fix: "Unclassified — read the raw error.",
		server: false,
	},
};

/** Which provider an error most likely came from, for a clearer message.
 * Reads the error text first, then falls back to the failed STAGE (each stage
 * uses a known provider: transcribe→Deepgram, titles→NVIDIA). */
function providerOf(low: string, stage: string | null): string | null {
	if (low.includes("deepgram")) return "Deepgram";
	if (low.includes("gemini") || low.includes("google")) return "Gemini";
	if (low.includes("nvidia") || low.includes("nim")) return "NVIDIA";
	// Fall back to the stage that failed.
	const s = (stage ?? "").toLowerCase();
	if (s === "transcribe") return "Deepgram";
	if (s === "titles") return "NVIDIA";
	return null;
}

/** Classify a job's failure from its error text + the stage it died at. */
export function classifyIssue(
	error: string | null,
	stage: string | null = null,
): {
	category: IssueCategory;
	provider: string | null;
} {
	const low = (error ?? "").toLowerCase();
	const has = (...needles: string[]) => needles.some((n) => low.includes(n));

	let category: IssueCategory = "other";
	if (has("402", "payment_required", "enough credits", "out of credits"))
		category = "key_credits";
	else if (has("401", "invalid_auth", "invalid credentials", "unauthorized"))
		category = "key_invalid";
	else if (
		has(
			"429",
			"rate limit",
			"rate-limit",
			"resource_exhausted",
			"quota",
			"too many requests",
		)
	)
		category = "key_rate";
	else if (
		has(
			"cookies",
			"sign in",
			"not a bot",
			"forbidden",
			"403",
			"private",
			"login",
			"no transcribable speech",
			"unavailable",
			"format is not available",
		)
	)
		category = "source";
	else if (has("render", "no clips", "ffmpeg", "all clip")) category = "render";
	else if (has("timed out", "timeout", "killed", "524", "gateway"))
		category = "timeout";

	return { category, provider: providerOf(low, stage) };
}

export type FailureRow = {
	type: "Dub" | "Short";
	email: string;
	stage: string | null;
	error: string;
	category: IssueCategory;
	provider: string | null;
	at: Date;
};

export type UserSummary = {
	email: string;
	role: string;
	dubDone: number;
	dubFailed: number;
	shortDone: number;
	shortFailed: number;
	topIssue: IssueCategory | null;
	/** Provider tied to the top issue (e.g. which key is out of credits). */
	topProvider: string | null;
	keys: {
		deepgram: boolean;
		gemini: boolean;
		nvidia: boolean;
		cookies: boolean;
	};
};

export type ServiceHealth = {
	dubberOk: boolean;
	r2Configured: boolean;
	runningDubs: number;
	runningShorts: number;
};

const WINDOW_HOURS = 48;

async function dubberHealthy(): Promise<boolean> {
	const base = process.env.DUBBER_SERVICE_URL ?? "http://127.0.0.1:8800";
	try {
		const r = await fetch(`${base}/health`, {
			signal: AbortSignal.timeout(3000),
		});
		return r.ok;
	} catch {
		return false;
	}
}

type JobRow = {
	userId: string;
	email: string | null;
	role: string | null;
	status: string;
	stage: string | null;
	error: string | null;
	at: Date;
};

/** Everything the diagnostics page needs, in one call. */
export async function getDiagnostics() {
	const since = new Date(Date.now() - WINDOW_HOURS * 3600_000);
	const cols = (t: typeof dubJobs | typeof shortsJobs) => ({
		userId: t.userId,
		email: users.email,
		role: users.role,
		status: t.status,
		stage: t.stage,
		error: t.error,
		at: t.createdAt,
	});

	const [dubs, shorts, keyRows, dubberOk] = await Promise.all([
		db
			.select(cols(dubJobs))
			.from(dubJobs)
			.innerJoin(users, eq(dubJobs.userId, users.id))
			.where(gte(dubJobs.createdAt, since))
			.orderBy(desc(dubJobs.createdAt)) as Promise<JobRow[]>,
		db
			.select(cols(shortsJobs))
			.from(shortsJobs)
			.innerJoin(users, eq(shortsJobs.userId, users.id))
			.where(gte(shortsJobs.createdAt, since))
			.orderBy(desc(shortsJobs.createdAt)) as Promise<JobRow[]>,
		db.select().from(userApiKeys),
		dubberHealthy(),
	]);

	const keysByUser = new Map(keyRows.map((k) => [k.userId, k]));

	// Classified failures, most-recent first.
	const failures: FailureRow[] = [];
	const collect = (type: "Dub" | "Short", rows: JobRow[]) => {
		for (const r of rows) {
			if (r.status !== "failed") continue;
			const { category, provider } = classifyIssue(r.error);
			failures.push({
				type,
				email: r.email ?? "(unknown)",
				stage: r.stage,
				error: r.error ?? "",
				category,
				provider,
				at: r.at,
			});
		}
	};
	collect("Dub", dubs);
	collect("Short", shorts);
	failures.sort((a, b) => b.at.getTime() - a.at.getTime());

	// Per-user rollup.
	type Issue = { category: IssueCategory; provider: string | null };
	const byEmail = new Map<string, UserSummary & { issues: Issue[] }>();
	const ensure = (r: JobRow) => {
		const key = r.email ?? "(unknown)";
		let s = byEmail.get(key);
		if (!s) {
			const k = keysByUser.get(r.userId);
			s = {
				email: key,
				role: r.role ?? "user",
				dubDone: 0,
				dubFailed: 0,
				shortDone: 0,
				shortFailed: 0,
				topIssue: null,
				topProvider: null,
				keys: {
					deepgram: !!k?.deepgramKeyEnc,
					gemini: !!k?.geminiKeyEnc,
					nvidia: !!k?.nvidiaKeyEnc,
					cookies: !!k?.cookiesEnc,
				},
				issues: [],
			};
			byEmail.set(key, s);
		}
		return s;
	};
	for (const r of dubs) {
		const s = ensure(r);
		if (r.status === "done") s.dubDone++;
		else if (r.status === "failed") {
			s.dubFailed++;
			s.issues.push(classifyIssue(r.error, r.stage));
		}
	}
	for (const r of shorts) {
		const s = ensure(r);
		if (r.status === "done") s.shortDone++;
		else if (r.status === "failed") {
			s.shortFailed++;
			s.issues.push(classifyIssue(r.error, r.stage));
		}
	}
	const userSummary: UserSummary[] = [...byEmail.values()]
		.map(({ issues, ...s }) => {
			// Most common failure category for the user, and the provider tied to
			// it (so "out of credits" names WHICH key).
			const tally = new Map<IssueCategory, number>();
			for (const i of issues)
				tally.set(i.category, (tally.get(i.category) ?? 0) + 1);
			const topIssue =
				[...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
			const provTally = new Map<string, number>();
			for (const i of issues)
				if (i.category === topIssue && i.provider)
					provTally.set(i.provider, (provTally.get(i.provider) ?? 0) + 1);
			const topProvider =
				[...provTally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
			return { ...s, topIssue, topProvider };
		})
		.sort(
			(a, b) =>
				b.dubFailed + b.shortFailed - (a.dubFailed + a.shortFailed) ||
				a.email.localeCompare(b.email),
		);

	return {
		health: {
			dubberOk,
			r2Configured: !!process.env.R2_ENDPOINT && !!process.env.R2_BUCKET,
			runningDubs: dubs.filter(
				(d) => d.status === "running" || d.status === "queued",
			).length,
			runningShorts: shorts.filter(
				(s) => s.status === "running" || s.status === "queued",
			).length,
		} as ServiceHealth,
		failures,
		userSummary,
		windowHours: WINDOW_HOURS,
	};
}
