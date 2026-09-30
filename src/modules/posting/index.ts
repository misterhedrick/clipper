import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { candidateClips, posts, sourceJobs, statusEvents, type PostPlatform, type PostStatus } from "../../db/schema.js";
import { STANDING_RULES, transition } from "../../db/transition.js";
import { loadCandidateWithContext } from "../../db/helpers.js";
import { canonical } from "../submissions/index.js";
import { validateCampaignConfig } from "../campaign-config/index.js";
import { validateCaption } from "../compliance/index.js";

// Publishing approved clips through OpusClip (docs/ARCHITECTURE.md, rule 9).
//
//   social plan → one post per account, each with a slot and the exact
//                 opusclip_schedule_publish params (the guard compares against them)
//   (operator)  → opusclip_schedule_publish with those params; OpusClip answers
//                 with an approval link and posts nothing until the person
//                 confirms it in the OpusClip app
//   social requested → records the approval link (or the failure)
//   social sync → reads opusclip_list_scheduled_posts: scheduled / posted (with
//                 the live link) / failed
//
// Code never posts and never decides a clip was posted: the person confirms each
// post in OpusClip, and marks the clip posted on the review page.

export type PostingErrorCode = "not_found" | "invalid_state" | "invalid_argument";

export class PostingError extends Error {
  constructor(
    public readonly code: PostingErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PostingError";
  }
}

export type PostingCtx = { db: Db; actor: string; now?: () => Date };

/** Where clips go (docs/SOCIAL_ACCOUNTS.md). Every approved clip is posted to each of these. */
export type PostAccount = { platform: PostPlatform; postAccountId: string; subAccountId?: string; handle: string };
export const POST_ACCOUNTS: readonly PostAccount[] = [
  { platform: "tiktok", postAccountId: "6abae1f395d6ba3043cddc87", handle: "@hedrick.clips" },
  { platform: "instagram", postAccountId: "6abadeddfcb3b882f21d6821", subAccountId: "17841433286283875", handle: "@hedrick.clips" },
  { platform: "youtube", postAccountId: "6abade79ae74eec7a3837564", handle: "@hedrickclips" },
];

/**
 * Spacing guidance per account: one post every 3 hours, 4 in any 24 hours.
 * Advisory since 2026-09-29: the person decides when to post ("post next"),
 * so a clip goes out right away and `social plan` only warns when it's closer
 * than this to that account's other posts. Two posts on one account are never
 * put in the same minute: MIN_SEPARATION_MINUTES apart at least.
 */
export const MIN_GAP_HOURS = 3;
export const MAX_PER_DAY = 4;
export const MIN_SEPARATION_MINUTES = 10;
/**
 * The earliest slot leaves the person this long to confirm the post in OpusClip.
 * An approval link stops working once its slot has passed, so the links go to
 * Discord the moment they exist (`social alert`). 15 minutes, the person's call (2026-09-29;
 * 5 minutes left too little time to send three requests and confirm them).
 */
export const LEAD_MINUTES = 15;

/**
 * How soon after a post goes live its link must be submitted on Whop (Content
 * Rewards campaigns live there: profile → Joined). Boxabl allows 30 minutes
 * (seen 2026-09-28, when three posts missed it); the tightest seen is used for all.
 */
export const SUBMIT_WINDOW_MINUTES = 30;

const HOUR = 3_600_000;
/** Statuses that hold a slot. */
const HOLDS_SLOT: readonly PostStatus[] = ["planned", "requested", "scheduled", "posted"];

/** The earliest time at or after `earliest` at least MIN_SEPARATION_MINUTES from every taken slot. */
export function nextSlot(taken: Date[], earliest: Date): Date {
  const gap = MIN_SEPARATION_MINUTES * 60_000;
  const times = taken.map((d) => d.getTime()).sort((a, b) => a - b);
  const start = earliest.getTime();
  const candidates = [start, ...times.map((x) => x + gap)].filter((t) => t >= start).sort((a, b) => a - b);
  for (const t of candidates) if (times.every((x) => Math.abs(x - t) >= gap)) return new Date(t);
  return new Date(Math.max(start, (times.at(-1) ?? start) + gap));
}

/** Spacing guidance an account would break by posting at `at` (advisory; see MIN_GAP_HOURS). */
export function spacingWarnings(taken: Date[], at: Date): string[] {
  const t = at.getTime();
  const out: string[] = [];
  const recent = taken.filter((d) => Math.abs(d.getTime() - t) < MIN_GAP_HOURS * HOUR);
  if (recent.length) out.push(`${recent.length} other post${recent.length === 1 ? "" : "s"} within ${MIN_GAP_HOURS}h`);
  const day = taken.filter((d) => d.getTime() > t - 24 * HOUR && d.getTime() <= t).length;
  if (day + 1 > MAX_PER_DAY) out.push(`${day + 1} posts in 24h (guideline ${MAX_PER_DAY})`);
  return out;
}

/** Slots are whole minutes, in UTC, as OpusClip takes them. */
const toIso = (d: Date) => new Date(Math.ceil(d.getTime() / 60_000) * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");

/**
 * YouTube shows `title` as the video title: 100 characters, no angle brackets.
 * Taken from the caption (checked against the campaign's rules and by the
 * reviewer), never from OpusClip's own clip title, which nobody checks
 * (it spelled Boxabl "Boxable", 2026-09-28): the caption's first line that
 * isn't only hashtags and tags.
 */
export function youtubeTitle(caption: string): string {
  const lines = caption.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => !/^([#@]\S+\s*)+$/.test(l)) ?? lines[0] ?? "";
  const base = line.replace(/[<>]/g, "");
  return base.length <= 100 ? base : `${base.slice(0, 99).trimEnd()}…`;
}

/** Exactly what the operator passes to opusclip_schedule_publish for one account. */
export function buildPostParams(
  a: PostAccount,
  clip: { projectId: string; clipId: string; title: string | null; caption: string },
  publishAt: string,
): Record<string, unknown> {
  const base = { projectId: clip.projectId, clipId: clip.clipId, postAccountId: a.postAccountId, publishAt };
  if (a.platform === "youtube") return { ...base, title: youtubeTitle(clip.caption), description: clip.caption, mediaType: "short" };
  if (a.platform === "instagram") return { ...base, ...(a.subAccountId ? { subAccountId: a.subAccountId } : {}), title: clip.caption, mediaType: "reel" };
  return { ...base, title: clip.caption };
}

const postView = (p: typeof posts.$inferSelect) => ({
  postId: p.id,
  platform: p.platform,
  account: p.accountHandle,
  status: p.status,
  publishAt: p.publishAt?.toISOString() ?? null,
  ...(p.status === "planned" ? { params: p.postParams } : {}),
  ...(p.approvalUrl ? { approvalUrl: p.approvalUrl } : {}),
  ...(p.url ? { url: p.url } : {}),
  ...(p.failureReason ? { failureReason: p.failureReason } : {}),
});

// --- plan ------------------------------------------------------------------------------

/**
 * Plans a ready_to_post clip's posts: one per account in POST_ACCOUNTS, each in
 * the account's next free slot, with the exact params to schedule. Idempotent:
 * accounts that already have a live or pending post for the clip are left alone.
 */
export async function planPosts(ctx: PostingCtx, id: string) {
  const row = await loadCandidateWithContext(ctx.db, id);
  if (!row) throw new PostingError("not_found", `No candidate ${id}`);
  const { clip, job, campaign } = row;
  if (clip.status !== "ready_to_post") {
    throw new PostingError("invalid_state", `Candidate ${id} is ${clip.status}; only packaged, ready_to_post clips are posted`);
  }
  if (!clip.packageKey) throw new PostingError("invalid_state", `Candidate ${id} isn't packaged; run \`clipper package ${id}\` first`);
  if (!job.opusclipProjectId) throw new PostingError("invalid_state", `Candidate ${id}'s job has no OpusClip project`);
  if (!clip.caption) throw new PostingError("invalid_state", `Candidate ${id} has no caption`);
  const caption = validateCaption(clip.caption, validateCampaignConfig(campaign.config));
  if (!caption.valid) {
    throw new PostingError("invalid_state", `The caption no longer meets the campaign's rules: ${caption.issues.map((i) => i.message).join("; ")}`);
  }
  const clipInfo = { projectId: job.opusclipProjectId, clipId: clip.opusclipClipId, title: clip.title, caption: clip.caption };
  const earliest = new Date((ctx.now?.() ?? new Date()).getTime() + LEAD_MINUTES * 60_000);

  return ctx.db.transaction(async (tx) => {
    // One planner at a time, so two runs can't take the same slot.
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('clipper:post-slots'))`);
    const mine = await tx.select().from(posts).where(eq(posts.candidateClipId, id));
    const planned: (typeof posts.$inferSelect)[] = [];
    const warnings: string[] = [];
    for (const account of POST_ACCOUNTS) {
      const existing = mine.find((p) => p.platform === account.platform && HOLDS_SLOT.includes(p.status));
      if (existing) {
        planned.push(existing);
        continue;
      }
      const taken = await tx
        .select({ at: posts.publishAt })
        .from(posts)
        .where(and(eq(posts.postAccountId, account.postAccountId), inArray(posts.status, [...HOLDS_SLOT])));
      const takenAt = taken.flatMap((t) => (t.at ? [t.at] : []));
      const publishAt = toIso(nextSlot(takenAt, earliest));
      for (const w of spacingWarnings(takenAt, new Date(publishAt))) warnings.push(`${account.platform} ${account.handle}: ${w}`);
      const postParams = buildPostParams(account, clipInfo, publishAt);
      const [created] = await tx
        .insert(posts)
        .values({
          candidateClipId: id,
          platform: account.platform,
          status: "planned",
          postAccountId: account.postAccountId,
          accountHandle: account.handle,
          publishAt: new Date(publishAt),
          postParams,
          postedAt: null,
        })
        .returning();
      await audit(tx, { entityType: "candidate_clip", entityId: id, action: "plan_post", actor: ctx.actor, details: { postId: created!.id, platform: account.platform, publishAt } });
      planned.push(created!);
    }
    return { id, posts: planned.map(postView), ...(warnings.length ? { spacingWarnings: warnings } : {}) };
  });
}

// --- queue -------------------------------------------------------------------------------

/**
 * Approved clips waiting to be posted, oldest approval first: the order "post
 * next" takes them in (decided 2026-09-29: nothing is scheduled ahead; the person
 * says when). A clip leaves the queue once any of its posts is planned or later.
 */
export async function postQueue(db: Db) {
  const rows = await db
    .select({ clip: candidateClips, campaignId: sourceJobs.campaignId })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .where(inArray(candidateClips.status, ["approved", "exporting", "ready_to_post"]));
  if (!rows.length) return { queue: [] };
  const ids = rows.map((r) => r.clip.id);
  const busy = new Set(
    (await db.select({ id: posts.candidateClipId }).from(posts).where(and(inArray(posts.candidateClipId, ids), inArray(posts.status, [...HOLDS_SLOT])))).map(
      (p) => p.id,
    ),
  );
  const approvals = await db
    .select({ id: statusEvents.entityId, at: statusEvents.createdAt })
    .from(statusEvents)
    .where(and(inArray(statusEvents.entityId, ids), eq(statusEvents.toStatus, "approved")));
  const approvedAt = new Map<string, Date>();
  for (const a of approvals) if (!approvedAt.has(a.id) || a.at < approvedAt.get(a.id)!) approvedAt.set(a.id, a.at);
  const queue = rows
    .filter((r) => !busy.has(r.clip.id))
    .sort((a, b) => (approvedAt.get(a.clip.id)?.getTime() ?? 0) - (approvedAt.get(b.clip.id)?.getTime() ?? 0))
    .map((r, i) => ({
      position: i + 1,
      candidateId: r.clip.id,
      title: r.clip.title,
      campaignId: r.campaignId,
      status: r.clip.status,
      packaged: !!r.clip.packageKey,
      approvedAt: approvedAt.get(r.clip.id)?.toISOString() ?? null,
    }));
  return { queue };
}

// --- guard -----------------------------------------------------------------------------

export type PostGuardVerdict = { allow: boolean; reason: string; postId?: string };

/**
 * The PreToolUse check behind .claude/hooks/guard-opusclip-post.sh. Allows an
 * opusclip_schedule_publish call only when its input equals the params of a
 * planned post whose clip is still ready_to_post. Immediate posts
 * (opusclip_create_post_task) are never allowed: every post takes a slot.
 */
export async function guardPost(db: Db, payloadText: string): Promise<PostGuardVerdict> {
  let payload: { tool_name?: unknown; tool_input?: unknown };
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { allow: false, reason: "Blocked: hook payload isn't JSON." };
  }
  if (typeof payload.tool_name !== "string" || !payload.tool_name.endsWith("opusclip_schedule_publish")) {
    return { allow: false, reason: "Blocked: clips are only posted with opusclip_schedule_publish, using the params from `clipper social plan`." };
  }
  const input = payload.tool_input as { projectId?: unknown; clipId?: unknown; postAccountId?: unknown } | undefined;
  if (!input || typeof input !== "object" || typeof input.clipId !== "string" || typeof input.postAccountId !== "string") {
    return { allow: false, reason: "Blocked: no clipId/postAccountId in the call." };
  }
  const rows = await db
    .select({ post: posts, status: candidateClips.status })
    .from(posts)
    .innerJoin(candidateClips, eq(candidateClips.id, posts.candidateClipId))
    .where(and(eq(candidateClips.opusclipClipId, input.clipId), eq(posts.postAccountId, input.postAccountId), eq(posts.status, "planned")));
  const [row] = rows;
  if (!row) return { allow: false, reason: `Blocked: no planned post for clip ${input.clipId} on account ${input.postAccountId}. Run \`clipper social plan\` first.` };
  if (row.status !== "ready_to_post") return { allow: false, reason: `Blocked: the clip is ${row.status}, not ready_to_post.`, postId: row.post.id };
  if (canonical(input) !== canonical(row.post.postParams)) {
    return { allow: false, reason: `Blocked: the call differs from planned post ${row.post.id}. Pass exactly the params \`social plan\` returned.`, postId: row.post.id };
  }
  return { allow: true, reason: `Allowed: matches planned post ${row.post.id}.`, postId: row.post.id };
}

// --- requested ---------------------------------------------------------------------------

async function loadPost(db: Db, postId: string) {
  const [p] = await db.select().from(posts).where(eq(posts.id, postId));
  if (!p) throw new PostingError("not_found", `No post ${postId}`);
  return p;
}

/**
 * Records what opusclip_schedule_publish answered for a planned post: the
 * approval link the person opens to confirm it, or the error (which frees the slot).
 */
export async function recordRequested(ctx: PostingCtx, postId: string, input: { approvalUrl?: string; error?: string }) {
  const p = await loadPost(ctx.db, postId);
  if (p.status === "requested" && input.approvalUrl && p.approvalUrl === input.approvalUrl) return { ...postView(p), alreadyRecorded: true };
  if (p.status !== "planned") throw new PostingError("invalid_state", `Post ${postId} is ${p.status}, not planned`);
  const approvalUrl = input.approvalUrl?.trim();
  const error = input.error?.trim();
  if (!approvalUrl === !error) throw new PostingError("invalid_argument", "Pass exactly one of --approval-url or --error");
  if (approvalUrl && !/^https:\/\//.test(approvalUrl)) throw new PostingError("invalid_argument", "--approval-url must be an https:// link");
  const set = approvalUrl ? { status: "requested" as const, approvalUrl } : { status: "cancelled" as const, failureReason: error!.slice(0, 500) };
  return ctx.db.transaction(async (tx) => {
    const [updated] = await tx.update(posts).set(set).where(and(eq(posts.id, postId), eq(posts.status, "planned"))).returning();
    if (!updated) throw new PostingError("invalid_state", `Post ${postId} changed while recording; re-read it`);
    await audit(tx, { entityType: "candidate_clip", entityId: p.candidateClipId, action: approvalUrl ? "post_requested" : "post_request_failed", actor: ctx.actor, details: { postId, ...set } });
    return postView(updated);
  });
}

/**
 * Drops a post the person never confirmed (its approval link expired, or they
 * decided against it): planned or requested → cancelled, which frees the slot so
 * `social plan` issues a fresh one. A post confirmed in OpusClip (scheduled)
 * is cancelled in OpusClip itself, not here.
 */
export async function cancelPost(ctx: PostingCtx, postId: string, reason: string) {
  const why = reason.trim();
  if (!why) throw new PostingError("invalid_argument", "--reason is required");
  const p = await loadPost(ctx.db, postId);
  if (p.status === "cancelled") return { ...postView(p), alreadyCancelled: true };
  if (p.status !== "planned" && p.status !== "requested") {
    throw new PostingError("invalid_state", `Post ${postId} is ${p.status}; only planned or requested posts are cancelled here (a scheduled post is cancelled in OpusClip)`);
  }
  return ctx.db.transaction(async (tx) => {
    const [updated] = await tx
      .update(posts)
      .set({ status: "cancelled", failureReason: why.slice(0, 500) })
      .where(and(eq(posts.id, postId), inArray(posts.status, ["planned", "requested"])))
      .returning();
    if (!updated) throw new PostingError("invalid_state", `Post ${postId} changed while cancelling; re-read it`);
    await audit(tx, { entityType: "candidate_clip", entityId: p.candidateClipId, action: "post_cancelled", actor: ctx.actor, details: { postId, from: p.status, reason: why } });
    return postView(updated);
  });
}

// --- sync --------------------------------------------------------------------------------

// opusclip_list_scheduled_posts. Only the fields we match and record are read;
// the rest passes through. Seen live 2026-09-28: {posts: [{schedule_id, project_id,
// clip_id, publish_at, status: "scheduled", platform: "TIKTOK_BUSINESS" |
// "INSTAGRAM_BUSINESS" | "YOUTUBE"}]}, with no account ID, so posts are matched
// on clip + platform (one post per platform per clip).
const scheduledPost = z
  .object({
    clip_id: z.string().optional(),
    clipId: z.string().optional(),
    post_account_id: z.string().optional(),
    postAccountId: z.string().optional(),
    platform: z.string().optional(),
    schedule_id: z.string().nullish(),
    status: z.string(),
    post_url: z.string().optional(),
    failure_reason: z.string().optional(),
    publish_at: z.string().nullish(),
    posted_at: z.string().nullish(),
  })
  .passthrough();
const scheduledList = z.object({ posts: z.array(scheduledPost) }).passthrough();

/** Accepts the tool's JSON, or the MCP envelope around it. */
export function parseScheduledPosts(input: unknown): z.infer<typeof scheduledPost>[] {
  let value = input;
  const content = (value as { content?: { type?: string; text?: string }[] } | null)?.content;
  if (Array.isArray(content)) {
    const text = content.find((c) => c.type === "text")?.text;
    try {
      value = JSON.parse(text ?? "");
    } catch {
      throw new PostingError("invalid_argument", "The opusclip_list_scheduled_posts result has no JSON text");
    }
  }
  const parsed = scheduledList.safeParse(value);
  if (!parsed.success) throw new PostingError("invalid_argument", `Not an opusclip_list_scheduled_posts result: ${parsed.error.issues[0]?.message}`);
  return parsed.data.posts;
}

/** OpusClip's platform names (TIKTOK_BUSINESS, INSTAGRAM_BUSINESS, YOUTUBE) → ours. */
export function platformOf(name: string | undefined): PostPlatform | undefined {
  const n = name?.toUpperCase() ?? "";
  return n.startsWith("TIKTOK") ? "tiktok" : n.startsWith("INSTAGRAM") ? "instagram" : n.startsWith("YOUTUBE") ? "youtube" : undefined;
}

const LIVE = /^(posted|published|success|succeeded|completed?)$/i;
const FAILED = /^(failed|failure|error|rejected)$/i;
const SCHEDULED = /^(scheduled|pending|queued|publishing|processing)$/i;

/**
 * Brings our posts in line with opusclip_list_scheduled_posts: a confirmed post
 * becomes scheduled, a live one posted with its link, a failed one failed.
 * Matches on clip + account. Returns the newly live links not yet sent to the
 * person (`newLinks`); `social notify` sends them. Then marks posted every
 * ready_to_post clip whose posts are all live with a link (`markLiveClipsPosted`).
 */
export async function syncPosts(ctx: PostingCtx, input: unknown) {
  const listed = parseScheduledPosts(input);
  const open = await ctx.db
    .select({ post: posts, clipId: candidateClips.opusclipClipId })
    .from(posts)
    .innerJoin(candidateClips, eq(candidateClips.id, posts.candidateClipId))
    .where(inArray(posts.status, ["planned", "requested", "scheduled", "posted"]));
  const changes: { postId: string; platform: string; from: string; to: string; url?: string }[] = [];
  const unmatched: unknown[] = [];

  await ctx.db.transaction(async (tx) => {
    for (const item of listed) {
      const clipId = item.clip_id ?? item.clipId;
      const accountId = item.post_account_id ?? item.postAccountId;
      const platform = platformOf(item.platform);
      const match = open.find(
        (o) => o.clipId === clipId && (accountId ? o.post.postAccountId === accountId : !!platform && o.post.platform === platform && !!o.post.postAccountId),
      );
      if (!match) {
        unmatched.push({ clipId: clipId ?? null, platform: item.platform ?? null, postAccountId: accountId ?? null, status: item.status });
        continue;
      }
      const p = match.post;
      const set: Partial<typeof posts.$inferInsert> = {};
      if (item.schedule_id && item.schedule_id !== p.opusclipScheduleId) set.opusclipScheduleId = item.schedule_id;
      if (LIVE.test(item.status)) {
        if (p.status !== "posted") {
          set.status = "posted";
          set.postedAt = new Date(item.posted_at ?? item.publish_at ?? (ctx.now?.() ?? new Date()).toISOString());
        }
        // TikTok Business can report posted before the link arrives: keep syncing until it does.
        if (item.post_url && item.post_url !== p.url) set.url = item.post_url;
      } else if (FAILED.test(item.status)) {
        if (p.status !== "failed") set.status = "failed";
        if (item.failure_reason && item.failure_reason !== p.failureReason) set.failureReason = item.failure_reason.slice(0, 500);
      } else if (SCHEDULED.test(item.status) && (p.status === "planned" || p.status === "requested")) {
        set.status = "scheduled";
      }
      if (!Object.keys(set).length) continue;
      await tx.update(posts).set(set).where(eq(posts.id, p.id));
      changes.push({ postId: p.id, platform: p.platform, from: p.status, to: set.status ?? p.status, ...(set.url ? { url: set.url } : {}) });
      await audit(tx, { entityType: "candidate_clip", entityId: p.candidateClipId, action: "post_synced", actor: ctx.actor, details: { postId: p.id, opusclipStatus: item.status, ...set } });
    }
  });

  // Posts not live yet: while any remain, the operator keeps syncing (the submit window is short).
  const [waiting] = await ctx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(posts)
    .where(inArray(posts.status, ["requested", "scheduled"]));
  const markedPosted = await markLiveClipsPosted(ctx);
  return { checked: listed.length, changes, unmatched, stillWaiting: waiting?.n ?? 0, markedPosted, newLinks: await linksToSend(ctx.db) };
}

/**
 * Standing rule (2026-09-30): a ready_to_post clip becomes posted once every one
 * of its posts is live with a link, as OpusClip reported it (the person already
 * confirmed each post in OpusClip). A post still waiting, failed, or live without
 * its link yet leaves the clip for later, or for the person to mark by hand.
 * Cancelled posts don't count. Covers every such clip, not only this sync's.
 */
export async function markLiveClipsPosted(ctx: PostingCtx) {
  const rows = await ctx.db
    .select({ clipId: candidateClips.id, post: posts })
    .from(candidateClips)
    .innerJoin(posts, eq(posts.candidateClipId, candidateClips.id))
    .where(eq(candidateClips.status, "ready_to_post"));
  const byClip = new Map<string, (typeof posts.$inferSelect)[]>();
  for (const r of rows) byClip.set(r.clipId, [...(byClip.get(r.clipId) ?? []), r.post]);

  const marked: { id: string; links: string[] }[] = [];
  for (const [id, clipPosts] of byClip) {
    const counted = clipPosts.filter((p) => p.status !== "cancelled");
    if (!counted.length || !counted.every((p) => p.status === "posted" && p.url)) continue;
    const links = counted.map((p) => `${p.platform}: ${p.url}`);
    await transition(ctx.db, {
      entity: "candidate_clip",
      id,
      to: "posted",
      actor: ctx.actor,
      reason: `live on ${links.join(", ")} (${STANDING_RULES.mark_posted_when_live})`,
      standingRule: "mark_posted_when_live",
      expectFrom: ["ready_to_post"],
    });
    marked.push({ id, links });
  }
  return marked;
}

// --- links for the person -----------------------------------------------------------------

/** Live posts with a link that the person hasn't been sent yet, with their clip and campaign. */
export async function linksToSend(db: Db) {
  const rows = await db
    .select({ post: posts, clip: candidateClips, jobCampaignId: sourceJobs.campaignId })
    .from(posts)
    .innerJoin(candidateClips, eq(candidateClips.id, posts.candidateClipId))
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .where(and(eq(posts.status, "posted"), isNull(posts.notifiedAt)))
    .orderBy(asc(posts.postedAt));
  return rows
    .filter((r) => r.post.url)
    .map((r) => ({
      postId: r.post.id,
      candidateId: r.clip.id,
      title: r.clip.title,
      platform: r.post.platform,
      account: r.post.accountHandle,
      url: r.post.url!,
      campaignId: r.jobCampaignId,
      postedAt: r.post.postedAt,
      // OpusClip reports the slot, not the moment it went live, so this errs early.
      submitBy: r.post.postedAt ? new Date(r.post.postedAt.getTime() + SUBMIT_WINDOW_MINUTES * 60_000) : null,
    }));
}

/** Marks links as sent, after the notification went out. */
export async function markNotified(db: Db, postIds: string[], at = new Date()) {
  if (!postIds.length) return;
  await db.update(posts).set({ notifiedAt: at }).where(and(inArray(posts.id, postIds), isNull(posts.notifiedAt)));
}

/**
 * Posts waiting for the person's confirmation whose slot hasn't passed, with one
 * link that confirms them all (OpusClip takes comma-joined approval tokens).
 */
export async function pendingApprovals(db: Db, now = new Date()) {
  const rows = await db
    .select({ post: posts, title: candidateClips.title })
    .from(posts)
    .innerJoin(candidateClips, eq(candidateClips.id, posts.candidateClipId))
    .where(eq(posts.status, "requested"))
    .orderBy(asc(posts.publishAt));
  const live = rows.filter((r) => r.post.approvalUrl && (!r.post.publishAt || r.post.publishAt > now));
  const tokens = live.map((r) => new URL(r.post.approvalUrl!).hash.slice(1)).filter(Boolean);
  return {
    combinedUrl: tokens.length ? `https://clip.opus.pro/agent-approvals#${tokens.join(",")}` : null,
    posts: live.map((r) => ({ postId: r.post.id, title: r.title, platform: r.post.platform, account: r.post.accountHandle, publishAt: r.post.publishAt })),
  };
}

/** A clip's posts, for `post list` and the review page. */
export async function postsForClip(db: Db, id: string) {
  const rows = await db.select().from(posts).where(eq(posts.candidateClipId, id)).orderBy(asc(posts.platform));
  return rows.map(postView);
}

/** Posts still waiting on OpusClip or the person, oldest slot first. */
export async function openPosts(db: Db) {
  const rows = await db
    .select({ post: posts, title: candidateClips.title })
    .from(posts)
    .innerJoin(candidateClips, eq(candidateClips.id, posts.candidateClipId))
    .where(inArray(posts.status, ["planned", "requested", "scheduled"]))
    .orderBy(asc(posts.publishAt));
  return { posts: rows.map((r) => ({ candidateId: r.post.candidateClipId, title: r.title, ...postView(r.post) })) };
}
