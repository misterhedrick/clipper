import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import {
  POST_PLATFORMS,
  campaigns,
  candidateClips,
  creditLedger,
  footageSources,
  posts,
  sourceJobs,
  statusEvents,
  type CampaignStatus,
  type CandidateClipStatus,
  type PostPlatform,
} from "../../db/schema.js";
import { isHumanActor, transition } from "../../db/transition.js";
import { validateCampaignConfig } from "../campaign-config/index.js";
import { CAPTION_CHECK, validateCaption } from "../compliance/index.js";
import { canonical } from "../submissions/index.js";

// Decisions only a person makes: confirming a campaign's config (→ active),
// deciding a clip's fate, and recording where it was posted. The web app calls
// these with a `reviewer:<name>` actor. They refuse any other actor themselves,
// and transition() refuses the human-only moves again underneath.

export type ReviewErrorCode = "human_only" | "not_found" | "invalid_argument" | "invalid_state";

export class ReviewError extends Error {
  constructor(
    public readonly code: ReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ReviewError";
  }
}

export type ReviewCtx = { db: Db; actor: string; now?: () => Date };

function requireHuman(ctx: ReviewCtx) {
  if (!isHumanActor(ctx.actor)) throw new ReviewError("human_only", `Only a reviewer can do this (actor: ${ctx.actor})`);
}

const requireText = (value: string | undefined, what: string) => {
  const t = value?.trim();
  if (!t) throw new ReviewError("invalid_argument", `${what} is required`);
  return t;
};

async function loadCampaign(db: Db, id: string) {
  const [c] = await db.select().from(campaigns).where(eq(campaigns.id, id));
  if (!c) throw new ReviewError("not_found", `No campaign ${id}`);
  return c;
}

async function loadCandidate(db: Db, id: string) {
  const [row] = await db
    .select({ clip: candidateClips, job: sourceJobs, campaign: campaigns })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(candidateClips.id, id));
  if (!row) throw new ReviewError("not_found", `No candidate ${id}`);
  return row;
}

// --- campaigns -----------------------------------------------------------------------

/**
 * Confirms a drafted config, possibly edited by the reviewer, and activates the
 * campaign. This is the only way a campaign becomes active.
 */
export async function confirmCampaign(ctx: ReviewCtx, id: string, configInput: unknown) {
  requireHuman(ctx);
  const c = await loadCampaign(ctx.db, id);
  if (c.status !== "pending_confirmation") {
    throw new ReviewError("invalid_state", `Campaign is ${c.status}; only a campaign pending confirmation can be confirmed`);
  }
  if (c.campaignType !== "lf") {
    throw new ReviewError("invalid_state", `Campaign type is ${c.campaignType ?? "unclassified"}; only long-form (lf) campaigns can be clipped with OpusClip`);
  }
  // Throws InvalidConfigError with field-level issues.
  const config = validateCampaignConfig(configInput);
  // Key order differs between jsonb and the schema, so compare canonically.
  const edited = canonical(config) !== canonical(c.config);
  const at = ctx.now?.() ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await transition(tx, {
      entity: "campaign",
      id,
      to: "active",
      actor: ctx.actor,
      reason: edited ? "config confirmed with reviewer edits" : "config confirmed as drafted",
      expectFrom: ["pending_confirmation"],
      set: { config, configConfirmedAt: at, configConfirmedBy: ctx.actor },
    });
    await audit(tx, { entityType: "campaign", entityId: id, action: "confirm_config", actor: ctx.actor, details: { edited, draft: c.config, confirmed: config } });
    return { id, status: "active" as const, edited };
  });
}

/**
 * A reviewer changes the config of a campaign that's already live. Status is
 * unchanged; the new config applies to every reservation from now on (jobs
 * already reserved keep the parameters they were issued).
 */
export async function editCampaignConfig(ctx: ReviewCtx, id: string, configInput: unknown) {
  requireHuman(ctx);
  const c = await loadCampaign(ctx.db, id);
  if (c.status !== "active" && c.status !== "paused") {
    throw new ReviewError("invalid_state", `Campaign is ${c.status}; only an active or paused campaign's config is edited here`);
  }
  const config = validateCampaignConfig(configInput);
  if (canonical(config) === canonical(c.config)) return { id, status: c.status, edited: false };
  const at = ctx.now?.() ?? new Date();
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .update(campaigns)
      .set({ config, configConfirmedAt: at, configConfirmedBy: ctx.actor, updatedAt: at })
      .where(and(eq(campaigns.id, id), inArray(campaigns.status, ["active", "paused"])))
      .returning({ id: campaigns.id });
    if (!row) throw new ReviewError("invalid_state", "Campaign changed status while saving; reload and try again");
    await audit(tx, { entityType: "campaign", entityId: id, action: "edit_config", actor: ctx.actor, details: { before: c.config, after: config } });
    return { id, status: c.status, edited: true };
  });
}

/**
 * A reviewer removes a campaign they don't want, with its footage sources, jobs,
 * candidate clips and credit ledger rows, so it can be added again from scratch
 * later. Refused once anything was posted. The status history stays, and an audit
 * row records what was removed (OpusClip keeps its own projects and usage).
 */
export async function deleteCampaign(ctx: ReviewCtx, id: string, confirmation: string | undefined) {
  requireHuman(ctx);
  const c = await loadCampaign(ctx.db, id);
  if (confirmation?.trim().toLowerCase() !== "delete") throw new ReviewError("invalid_argument", "Type delete to confirm");
  return ctx.db.transaction(async (tx) => {
    const jobs = await tx.select({ id: sourceJobs.id }).from(sourceJobs).where(eq(sourceJobs.campaignId, id));
    const jobIds = jobs.map((j) => j.id);
    const clips = jobIds.length
      ? await tx.select({ id: candidateClips.id }).from(candidateClips).where(inArray(candidateClips.sourceJobId, jobIds))
      : [];
    const clipIds = clips.map((x) => x.id);
    if (clipIds.length && (await tx.select({ id: posts.id }).from(posts).where(inArray(posts.candidateClipId, clipIds)).limit(1)).length) {
      throw new ReviewError("invalid_state", "Clips from this campaign were posted; a campaign with posts can't be deleted");
    }
    const ledger = await tx.delete(creditLedger).where(eq(creditLedger.campaignId, id)).returning({ credits: creditLedger.creditsReserved, status: creditLedger.status });
    if (clipIds.length) await tx.delete(candidateClips).where(inArray(candidateClips.id, clipIds));
    if (jobIds.length) await tx.delete(sourceJobs).where(inArray(sourceJobs.id, jobIds));
    const sources = await tx.delete(footageSources).where(eq(footageSources.campaignId, id)).returning({ id: footageSources.id });
    await tx.delete(campaigns).where(eq(campaigns.id, id));
    const removed = {
      footageSources: sources.length,
      sourceJobs: jobIds.length,
      candidateClips: clipIds.length,
      creditsConsumed: ledger.filter((l) => l.status === "consumed").reduce((n, l) => n + l.credits, 0),
    };
    await audit(tx, {
      entityType: "campaign",
      entityId: id,
      action: "delete_campaign",
      actor: ctx.actor,
      details: { title: c.title, contentRewardsCampaignId: c.contentRewardsCampaignId, status: c.status, ...removed },
    });
    return { id, deleted: true as const, ...removed };
  });
}

/** Sends a draft back to the operator with what to change (→ needs_attention). */
export async function requestConfigChanges(ctx: ReviewCtx, id: string, reason: string) {
  requireHuman(ctx);
  const why = requireText(reason, "What to change");
  await transition(ctx.db, { entity: "campaign", id, to: "needs_attention", actor: ctx.actor, reason: `config changes requested: ${why}`, expectFrom: ["pending_confirmation"] });
  return { id, status: "needs_attention" as const };
}

export async function setCampaignPaused(ctx: ReviewCtx, id: string, paused: boolean, reason?: string) {
  requireHuman(ctx);
  const to: CampaignStatus = paused ? "paused" : "active";
  const from: CampaignStatus = paused ? "active" : "paused";
  await transition(ctx.db, { entity: "campaign", id, to, actor: ctx.actor, reason: reason?.trim() || (paused ? "paused by reviewer" : "resumed by reviewer"), expectFrom: [from] });
  return { id, status: to };
}

// --- candidates ----------------------------------------------------------------------

export const DECISIONS = ["approve", "needs_edit", "reject", "hold"] as const;
export type Decision = (typeof DECISIONS)[number];

export type DecisionInput = { decision: string; notes?: string; overrideFailedChecks?: boolean };

/**
 * A reviewer's decision on a candidate. Approval needs a caption that passes the
 * campaign's caption rules, and an explicit override (with notes) if any
 * objective check failed. needs_edit, reject and hold need notes.
 */
export async function decideCandidate(ctx: ReviewCtx, id: string, input: DecisionInput) {
  requireHuman(ctx);
  if (!(DECISIONS as readonly string[]).includes(input.decision)) {
    throw new ReviewError("invalid_argument", `Decision must be one of ${DECISIONS.join(", ")}`);
  }
  const decision = input.decision as Decision;
  const notes = input.notes?.trim() || undefined;
  const { clip, campaign } = await loadCandidate(ctx.db, id);

  const from: readonly CandidateClipStatus[] = decision === "reject" ? ["awaiting_review", "needs_edit"] : ["awaiting_review"];
  if (!from.includes(clip.status)) {
    throw new ReviewError("invalid_state", `Candidate is ${clip.status}; "${decision}" applies to ${from.join(" or ")} candidates`);
  }

  if (decision === "hold") {
    const why = requireText(notes, "A note on why it's on hold");
    return ctx.db.transaction(async (tx) => {
      await tx.update(candidateClips).set({ reviewNotes: why }).where(eq(candidateClips.id, id));
      await audit(tx, { entityType: "candidate_clip", entityId: id, action: "hold", actor: ctx.actor, details: { notes: why } });
      return { id, status: clip.status, decision };
    });
  }
  if (decision === "needs_edit") requireText(notes, "What to fix");
  if (decision === "reject") requireText(notes, "Why it's rejected");

  if (decision === "approve") {
    const failed = Object.entries(clip.checkResults ?? {})
      .filter(([k, v]) => v === "fail" && k !== CAPTION_CHECK)
      .map(([k]) => k);
    if (failed.length && !(input.overrideFailedChecks && notes)) {
      throw new ReviewError("invalid_state", `Checks failed (${failed.join(", ")}). To approve anyway, tick the override and say why in the notes.`);
    }
    if (!clip.caption) throw new ReviewError("invalid_state", "Set a caption before approving: it's what gets posted");
    const caption = validateCaption(clip.caption, validateCampaignConfig(campaign.config));
    if (!caption.valid) {
      throw new ReviewError("invalid_state", `The caption no longer meets the campaign's rules: ${caption.issues.map((i) => i.message).join("; ")}`);
    }
  }

  const to: CandidateClipStatus = decision === "approve" ? "approved" : decision === "needs_edit" ? "needs_edit" : "rejected";
  await transition(ctx.db, {
    entity: "candidate_clip",
    id,
    to,
    actor: ctx.actor,
    reason: notes ?? `${decision} by reviewer`,
    expectFrom: from,
    set: notes ? { reviewNotes: notes } : {},
  });
  return { id, status: to, decision };
}

/** Records (or updates) where a clip was posted. The first post moves ready_to_post → posted. */
export async function recordPost(
  ctx: ReviewCtx,
  id: string,
  input: { platform: string; url: string; postedAt?: Date; views?: number; likes?: number; earnings?: number; notes?: string },
) {
  requireHuman(ctx);
  if (!(POST_PLATFORMS as readonly string[]).includes(input.platform)) {
    throw new ReviewError("invalid_argument", `Platform must be one of ${POST_PLATFORMS.join(", ")}`);
  }
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    throw new ReviewError("invalid_argument", "Post URL must be a full https:// link");
  }
  if (url.protocol !== "https:") throw new ReviewError("invalid_argument", "Post URL must be a full https:// link");
  for (const [k, v] of Object.entries({ views: input.views, likes: input.likes, earnings: input.earnings })) {
    if (v !== undefined && (!Number.isFinite(v) || v < 0)) throw new ReviewError("invalid_argument", `${k} must be a number ≥ 0`);
  }
  const { clip } = await loadCandidate(ctx.db, id);
  if (clip.status !== "ready_to_post" && clip.status !== "posted") {
    throw new ReviewError("invalid_state", `Candidate is ${clip.status}; posts are recorded for ready_to_post or posted clips`);
  }
  const platform = input.platform as PostPlatform;
  const values = {
    url: url.toString(),
    postedAt: input.postedAt ?? ctx.now?.() ?? new Date(),
    views: input.views ?? null,
    likes: input.likes ?? null,
    earnings: input.earnings === undefined ? null : String(input.earnings),
    notes: input.notes?.trim() || null,
  };
  return ctx.db.transaction(async (tx) => {
    const [existing] = await tx.select().from(posts).where(and(eq(posts.candidateClipId, id), eq(posts.platform, platform)));
    const [row] = existing
      ? await tx.update(posts).set(values).where(eq(posts.id, existing.id)).returning()
      : await tx.insert(posts).values({ candidateClipId: id, platform, ...values }).returning();
    await audit(tx, { entityType: "candidate_clip", entityId: id, action: existing ? "update_post" : "record_post", actor: ctx.actor, details: { platform, ...values } });
    if (clip.status === "ready_to_post") {
      await transition(tx, { entity: "candidate_clip", id, to: "posted", actor: ctx.actor, reason: `posted to ${platform}: ${values.url}` });
    }
    return { id, status: "posted" as const, post: row! };
  });
}

// --- reads for the pages -----------------------------------------------------------------

export async function campaignsForReview(db: Db) {
  return db.select().from(campaigns).orderBy(desc(campaigns.updatedAt));
}

export async function candidatesByStatus(db: Db, statuses: readonly CandidateClipStatus[], campaignId?: string) {
  return db
    .select({ clip: candidateClips, job: sourceJobs, campaign: { id: campaigns.id, title: campaigns.title } })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(and(inArray(candidateClips.status, [...statuses]), campaignId ? eq(campaigns.id, campaignId) : undefined))
    .orderBy(asc(candidateClips.createdAt));
}

export async function candidateDetail(db: Db, id: string) {
  const row = await loadCandidate(db, id);
  const events = await db
    .select()
    .from(statusEvents)
    .where(and(eq(statusEvents.entityType, "candidate_clip"), eq(statusEvents.entityId, id)))
    .orderBy(asc(statusEvents.createdAt));
  const postRows = await db.select().from(posts).where(eq(posts.candidateClipId, id)).orderBy(asc(posts.platform));
  return { ...row, events, posts: postRows };
}

export async function campaignDetail(db: Db, id: string) {
  const campaign = await loadCampaign(db, id);
  const events = await db
    .select()
    .from(statusEvents)
    .where(and(eq(statusEvents.entityType, "campaign"), eq(statusEvents.entityId, id)))
    .orderBy(desc(statusEvents.createdAt))
    .limit(20);
  const waiting = await db
    .select({ id: candidateClips.id })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .where(and(eq(sourceJobs.campaignId, id), inArray(candidateClips.status, ["awaiting_review", "needs_edit"])));
  return { campaign, events, waitingClips: waiting.length };
}
