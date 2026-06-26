import "server-only";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import {
	postsLog,
	shortsClips,
	shortsDistributions,
	shortsJobs,
	users,
} from "@/db/schema";
import type { AppUser } from "@/lib/auth";
import { scheduleVideoToAccounts } from "@/lib/dub-autopublish";
import { getAccessibleProfiles } from "@/lib/queries";

const SOURCE = "short-auto";

/** When to schedule the next clip for a set of accounts: never closer than
 * gapMinutes after the latest still-pending short-auto post to those accounts,
 * and never before now + bufferMinutes. Drips correctly even though clips
 * arrive asynchronously across cron runs. */
async function dripSlot(
	accountIds: string[],
	bufferMinutes: number,
	gapMinutes: number,
): Promise<string> {
	const nowMs = Date.now();
	const earliest = nowMs + bufferMinutes * 60_000;
	if (gapMinutes <= 0) return new Date(earliest).toISOString();
	const [row] = await db
		.select({ last: sql<string | null>`max(${postsLog.scheduledFor})` })
		.from(postsLog)
		.where(
			and(
				eq(postsLog.source, SOURCE),
				eq(postsLog.status, "scheduled"),
				gt(postsLog.scheduledFor, new Date(nowMs)),
				inArray(sql`(${postsLog.platforms} -> 0 ->> 'accountId')`, accountIds),
			),
		);
	const lastMs = row?.last ? new Date(row.last).getTime() : 0;
	const whenMs =
		lastMs > 0 ? Math.max(earliest, lastMs + gapMinutes * 60_000) : earliest;
	return new Date(whenMs).toISOString();
}

/**
 * For every shorts job opted into a distribution, schedule its NEW finished
 * clips: clip idx i goes to ecosystem floor((i-1)/shortsPerTarget) — a distinct
 * slice per ecosystem, broadcast to that ecosystem's accounts, drip-spaced.
 * Idempotent across the clip-rebuilding sync cron by tracking published clip
 * idxs on the JOB (auto_published_idxs). Returns # clip posts scheduled.
 */
export async function runShortsAutopublish(): Promise<number> {
	const jobs = await db
		.select({ job: shortsJobs, owner: users })
		.from(shortsJobs)
		.innerJoin(users, eq(users.id, shortsJobs.userId))
		.where(isNotNull(shortsJobs.autoPublishDistributionId))
		.orderBy(desc(shortsJobs.createdAt))
		.limit(100);

	let published = 0;
	for (const { job, owner } of jobs) {
		const distId = job.autoPublishDistributionId;
		if (!distId) continue;
		const dist = await db.query.shortsDistributions.findFirst({
			where: eq(shortsDistributions.id, distId),
		});
		if (!dist) continue;

		// Group selected accounts by ecosystem (accessible to the job owner).
		const accessible = new Set(
			(await getAccessibleProfiles(owner as AppUser)).map((p) => p.id),
		);
		const byEco = new Map<string, string[]>();
		const ecoOrder: string[] = [];
		for (const t of dist.targets) {
			if (!accessible.has(t.profileId)) continue;
			if (!byEco.has(t.profileId)) {
				byEco.set(t.profileId, []);
				ecoOrder.push(t.profileId);
			}
			byEco.get(t.profileId)?.push(t.accountId);
		}
		if (ecoOrder.length === 0) continue;
		const per = dist.shortsPerTarget;

		const doneIdxs = new Set(job.autoPublishedIdxs ?? []);
		const clips = await db
			.select()
			.from(shortsClips)
			.where(
				and(eq(shortsClips.jobId, job.id), isNotNull(shortsClips.publicUrl)),
			)
			.orderBy(shortsClips.idx);

		let changed = false;
		for (const clip of clips) {
			if (doneIdxs.has(clip.idx)) continue;
			const ecoIndex = Math.floor((clip.idx - 1) / per);
			if (ecoIndex >= ecoOrder.length) {
				// Past the per-ecosystem cap — never published; mark so we stop
				// re-checking it on every tick.
				doneIdxs.add(clip.idx);
				changed = true;
				continue;
			}
			const profileId = ecoOrder[ecoIndex];
			const accountIds = byEco.get(profileId) ?? [];
			const url = clip.publicUrl;
			if (!url) continue;
			const head = [clip.title, clip.description].filter(Boolean).join("\n\n");
			const tags = clip.hashtags ?? [];
			const caption =
				(head || `Short #${clip.idx}`) +
				(tags.length ? `\n\n${tags.map((h) => `#${h}`).join(" ")}` : "");
			const when = await dripSlot(
				accountIds,
				dist.bufferMinutes,
				dist.gapMinutes,
			);
			const n = await scheduleVideoToAccounts(
				profileId,
				job.userId,
				caption,
				url,
				accountIds,
				when,
				SOURCE,
			);
			if (n > 0) {
				doneIdxs.add(clip.idx);
				changed = true;
				published += n;
			}
			// n === 0 → leave unmarked so it retries on the next tick.
		}
		if (changed) {
			await db
				.update(shortsJobs)
				.set({ autoPublishedIdxs: [...doneIdxs] })
				.where(eq(shortsJobs.id, job.id));
		}
	}
	return published;
}
