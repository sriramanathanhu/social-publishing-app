import { eq } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { postsLog } from "@/db/schema";
import { requireUser } from "@/lib/auth";
import { route } from "@/lib/http";
import { type CreatePostInput, PLATFORMS, postpeer } from "@/lib/postpeer";
import { assertAccountInProfile, assertProfileAccess } from "@/lib/rbac";

type Ctx = { params: Promise<{ id: string }> };

/** GET — audit log of posts for this profile. */
export const GET = route(async (_req: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const posts = await db
		.select()
		.from(postsLog)
		.where(eq(postsLog.profileId, id))
		.orderBy(postsLog.createdAt);

	return Response.json({ posts });
});

const mediaSchema = z.object({
	type: z.enum(["image", "video", "gif"]),
	url: z.string().url(),
	thumbnail: z.string().url().optional(),
});

const publishSchema = z
	.object({
		content: z.string().min(1),
		platforms: z
			.array(
				z.object({
					platform: z.enum(PLATFORMS),
					accountId: z.string().min(1),
					content: z.string().optional(),
					platformSpecificData: z.record(z.unknown()).optional(),
				}),
			)
			.min(1),
		mediaItems: z.array(mediaSchema).optional(),
		publishNow: z.boolean().optional(),
		scheduledFor: z.string().datetime().optional(),
		timezone: z.string().optional(),
	})
	.refine((d) => d.publishNow || d.scheduledFor, {
		message: "Provide publishNow:true or scheduledFor",
	});

/**
 * POST /api/profiles/:id/posts  (req #6 — schedule/publish)
 *
 * Editor+ on the profile. Crucially, every target accountId is re-validated
 * against integrations_cache for THIS profile, so a client can never publish to
 * an account it doesn't own. Then we proxy to PostPeer and log the result.
 */
export const POST = route(async (request: NextRequest, { params }: Ctx) => {
	const user = await requireUser();
	const { id } = await params;
	await assertProfileAccess(user, id);

	const input = publishSchema.parse(await request.json());

	// Authorize each target account belongs to this profile.
	await Promise.all(
		input.platforms.map((p) => assertAccountInProfile(user, id, p.accountId)),
	);

	const isScheduled = !input.publishNow && !!input.scheduledFor;

	const [logRow] = await db
		.insert(postsLog)
		.values({
			profileId: id,
			authorUserId: user.id,
			status: isScheduled ? "scheduled" : "publishing",
			content: input.content,
			platforms: input.platforms.map((p) => ({
				platform: p.platform,
				accountId: p.accountId,
				content: p.content,
			})),
			scheduledFor: input.scheduledFor ? new Date(input.scheduledFor) : null,
			timezone: input.timezone ?? null,
		})
		.returning();

	try {
		const payload: CreatePostInput = {
			content: input.content,
			platforms: input.platforms,
			mediaItems: input.mediaItems,
			publishNow: input.publishNow,
			scheduledFor: input.scheduledFor,
			timezone: input.timezone,
		};
		const result = await postpeer.createPost(payload);
		const postpeerPostId = result.postId ?? null;
		const platformResults = result.platforms ?? [];

		// PostPeer returns 202 even on per-platform failure, so trust `success`.
		if (!result.success) {
			const detail =
				platformResults
					.filter((p) => !p.success)
					.map((p) => `${p.platform}: ${p.error ?? "failed"}`)
					.join("; ") ||
				result.message ||
				"Publishing failed";

			await db
				.update(postsLog)
				.set({ status: "failed", postpeerPostId, error: detail })
				.where(eq(postsLog.id, logRow.id));

			return Response.json(
				{ error: detail, platforms: platformResults },
				{ status: 400 },
			);
		}

		await db
			.update(postsLog)
			.set({
				postpeerPostId,
				status: isScheduled ? "scheduled" : "published",
			})
			.where(eq(postsLog.id, logRow.id));

		return Response.json(
			{ post: { ...logRow, postpeerPostId }, platforms: platformResults },
			{ status: 201 },
		);
	} catch (err) {
		await db
			.update(postsLog)
			.set({
				status: "failed",
				error: err instanceof Error ? err.message : String(err),
			})
			.where(eq(postsLog.id, logRow.id));
		throw err;
	}
});
