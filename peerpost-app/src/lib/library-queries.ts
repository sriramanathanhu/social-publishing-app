import "server-only";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	articles,
	type DubCaption,
	dubJobs,
	quoteItems,
	transcriptJobs,
	users,
} from "@/db/schema";
import { langLabel } from "@/lib/dub-options";
import { loadTags } from "@/lib/library-tags";
import { r2PublicUrl } from "@/lib/r2";

/** Best caption (title + description) from a dub's per-platform AI captions. */
function dubCaptionText(
	captions: Record<string, DubCaption> | null | undefined,
): string | null {
	if (!captions) return null;
	const prefer = ["instagram", "youtube", "facebook", "linkedin", "twitter"];
	const keys = [...prefer.filter((k) => captions[k]), ...Object.keys(captions)];
	for (const k of keys) {
		const c = captions[k];
		const title = c?.title?.trim();
		const body = c?.caption?.trim();
		if (title || body) {
			return title && body ? `${title}\n\n${body}` : title || body || null;
		}
	}
	return null;
}

/** Library galleries load one page at a time; "Show more" fetches the next. */
export const LIB_PAGE = 48;

const who = (name: string | null, email: string | null) =>
	name?.trim() || email?.trim() || "Unknown";

export function snippet(md: string): string {
	return md
		.replace(/^#{1,6}\s+/gm, "")
		.replace(/[*_`>#[\]]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 220);
}

// ── Articles ───────────────────────────────────────────────────────────────
export async function loadArticlesPage(
	userId: string,
	offset: number,
	limit = LIB_PAGE,
) {
	const rows = await db
		.select({
			id: articles.id,
			title: articles.title,
			topic: articles.topic,
			content: articles.content,
			provider: articles.provider,
			outputLang: articles.outputLang,
			createdAt: articles.createdAt,
			authorName: users.name,
			authorEmail: users.email,
		})
		.from(articles)
		.innerJoin(users, eq(articles.userId, users.id))
		.orderBy(desc(articles.createdAt))
		.limit(limit)
		.offset(offset);
	const tags = await loadTags(
		userId,
		"article",
		rows.map((r) => r.id),
	);
	return {
		items: rows.map((a) => ({
			id: a.id,
			title: a.title || a.topic,
			snippet: snippet(a.content),
			provider: a.provider,
			tags: tags[a.id] ?? [],
			createdAt: String(a.createdAt),
			author: who(a.authorName, a.authorEmail),
			lang: a.outputLang,
		})),
		hasMore: rows.length === limit,
	};
}

// ── Quotes ─────────────────────────────────────────────────────────────────
export async function loadQuotesPage(
	userId: string,
	offset: number,
	limit = LIB_PAGE,
) {
	const rows = await db
		.select({
			id: quoteItems.id,
			text: quoteItems.text,
			cardUrl: quoteItems.cardUrl,
			outputLang: quoteItems.outputLang,
			createdAt: quoteItems.createdAt,
			authorName: users.name,
			authorEmail: users.email,
		})
		.from(quoteItems)
		.innerJoin(users, eq(quoteItems.userId, users.id))
		.orderBy(desc(quoteItems.createdAt))
		.limit(limit)
		.offset(offset);
	const tags = await loadTags(
		userId,
		"quote",
		rows.map((r) => r.id),
	);
	return {
		items: rows.map((i) => ({
			id: i.id,
			text: i.text,
			cardUrl: i.cardUrl,
			tags: tags[i.id] ?? [],
			createdAt: String(i.createdAt),
			author: who(i.authorName, i.authorEmail),
			lang: i.outputLang,
		})),
		hasMore: rows.length === limit,
	};
}

/** Distinct languages + users across ALL quotes (for the filter dropdowns —
 * independent of which page is loaded). */
export async function loadQuoteFacets() {
	const [langRows, userRows] = await Promise.all([
		db.selectDistinct({ lang: quoteItems.outputLang }).from(quoteItems),
		db
			.selectDistinct({ name: users.name, email: users.email })
			.from(quoteItems)
			.innerJoin(users, eq(quoteItems.userId, users.id)),
	]);
	const langs = [
		...new Set(langRows.map((r) => r.lang).filter((l): l is string => !!l)),
	].sort();
	const usersList = [
		...new Set(userRows.map((r) => who(r.name, r.email))),
	].sort();
	return { langs, users: usersList };
}

// ── Transcripts ────────────────────────────────────────────────────────────
export async function loadTranscriptsPage(
	userId: string,
	offset: number,
	limit = LIB_PAGE,
) {
	const rows = await db
		.select({
			id: transcriptJobs.id,
			title: transcriptJobs.title,
			outputLang: transcriptJobs.outputLang,
			corpusKey: transcriptJobs.corpusKey,
			pushedAt: transcriptJobs.pushedAt,
			createdAt: transcriptJobs.createdAt,
			transcript: transcriptJobs.transcript,
			authorName: users.name,
			authorEmail: users.email,
		})
		.from(transcriptJobs)
		.innerJoin(users, eq(transcriptJobs.userId, users.id))
		.where(
			and(
				eq(transcriptJobs.status, "done"),
				isNotNull(transcriptJobs.transcript),
			),
		)
		.orderBy(desc(transcriptJobs.createdAt))
		.limit(limit)
		.offset(offset);
	const tags = await loadTags(
		userId,
		"transcript",
		rows.map((r) => r.id),
	);
	return {
		items: rows.map((t) => ({
			id: t.id,
			title: t.title,
			lang: t.outputLang,
			corpusKey: t.corpusKey,
			pushedAt: t.pushedAt ? String(t.pushedAt) : null,
			createdAt: String(t.createdAt),
			transcript: t.transcript ?? "",
			author: who(t.authorName, t.authorEmail),
			tags: tags[t.id] ?? [],
		})),
		hasMore: rows.length === limit,
	};
}

// ── Video (union of uploads + shorts + dubbed outputs) ──────────────────────
type VideoRow = {
	id: string;
	kind: "video" | "short" | "dub";
	title: string;
	url: string | null;
	archive_key: string | null;
	duration_sec: number | null;
	viral_score: number | null;
	lang: string | null;
	captions: Record<string, DubCaption> | null;
	created_at: string | Date;
	user_name: string | null;
	user_email: string | null;
};

export async function loadVideoPage(
	userId: string,
	offset: number,
	limit = LIB_PAGE,
) {
	const result = await db.execute(sql`
		SELECT id, kind, title, url, archive_key, duration_sec, viral_score, lang,
		       captions, created_at, user_name, user_email
		FROM (
			SELECT uv.id::text AS id, 'video' AS kind, uv.title, uv.url,
			       NULL::text AS archive_key, NULL::int AS duration_sec,
			       NULL::int AS viral_score, NULL::text AS lang, NULL::jsonb AS captions,
			       uv.created_at, u.name AS user_name, u.email AS user_email
			FROM user_videos uv JOIN users u ON u.id = uv.user_id
			UNION ALL
			SELECT sc.id::text, 'short', COALESCE(sc.title, 'Short clip'),
			       sc.public_url, NULL::text, sc.duration_sec, sc.viral_score,
			       sj.settings->>'language', NULL::jsonb, sj.created_at, u.name, u.email
			FROM shorts_clips sc
			JOIN shorts_jobs sj ON sj.id = sc.job_id
			JOIN users u ON u.id = sj.user_id
			WHERE sc.public_url IS NOT NULL
			UNION ALL
			SELECT dj.id::text, 'dub', 'Dubbed → ' || dj.target_lang,
			       NULL::text, dj.archive_key, NULL::int, NULL::int,
			       dj.target_lang, dj.captions, dj.created_at, u.name, u.email
			FROM dub_jobs dj JOIN users u ON u.id = dj.user_id
			WHERE dj.status = 'done' AND dj.archive_key IS NOT NULL
		) t
		ORDER BY created_at DESC, id
		LIMIT ${limit} OFFSET ${offset}
	`);
	const rows = result as unknown as VideoRow[];

	const byKind: Record<string, string[]> = { video: [], short: [], dub: [] };
	for (const r of rows) byKind[r.kind]?.push(r.id);
	const [vt, st, dt] = await Promise.all([
		loadTags(userId, "video", byKind.video),
		loadTags(userId, "short", byKind.short),
		loadTags(userId, "dub", byKind.dub),
	]);
	const tagsFor = (kind: string, id: string) =>
		(kind === "video" ? vt : kind === "short" ? st : dt)[id] ?? [];

	const items = rows
		.map((r) => {
			const url = r.url ?? (r.archive_key ? r2PublicUrl(r.archive_key) : null);
			if (!url) return null;
			const caption = r.kind === "dub" ? dubCaptionText(r.captions) : null;
			return {
				id: r.id,
				kind: r.kind,
				// Spell out the language on dubs ("Dubbed → Hindi", not "→ hi").
				title: r.kind === "dub" ? `Dubbed → ${langLabel(r.lang)}` : r.title,
				url,
				durationSec: r.duration_sec,
				viralScore: r.viral_score,
				lang: r.lang,
				caption,
				tags: tagsFor(r.kind, r.id),
				createdAt: String(r.created_at),
				userName: who(r.user_name, r.user_email),
			};
		})
		.filter((i): i is NonNullable<typeof i> => i !== null);
	return { items, hasMore: rows.length === limit };
}

/** Full source→dubbed-outputs map (small; not paginated) for the "dubbed" chips. */
export async function loadDubBySource() {
	const dubs = await db
		.select({
			targetLang: dubJobs.targetLang,
			archiveKey: dubJobs.archiveKey,
			sourceLibraryId: dubJobs.sourceLibraryId,
		})
		.from(dubJobs)
		.where(and(eq(dubJobs.status, "done"), isNotNull(dubJobs.archiveKey)));
	const map: Record<string, { lang: string; url: string }[]> = {};
	for (const d of dubs) {
		const url = d.archiveKey ? r2PublicUrl(d.archiveKey) : null;
		if (d.sourceLibraryId && url)
			(map[d.sourceLibraryId] ??= []).push({ lang: d.targetLang, url });
	}
	return map;
}
