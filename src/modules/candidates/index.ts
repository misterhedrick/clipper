import { and, asc, desc, eq, inArray } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import {
  CANDIDATE_CLIP_STATUSES,
  PRESCREEN_VERDICTS,
  campaigns,
  candidateClips,
  sourceJobs,
  statusEvents,
  type CandidateClipStatus,
  type PrescreenVerdict,
  type SourceJobStatus,
} from "../../db/schema.js";
import { recordCreated, transition } from "../../db/transition.js";
import { validateCampaignConfig, type CampaignConfig } from "../campaign-config/index.js";
import { CAPTION_CHECK, runObjectiveChecks, validateCaption, type CaptionIssue, type CheckResults } from "../compliance/index.js";
import { classifyStage, OpusClipParseError, parseOpusClipList, type OpusClip } from "./opusclip.js";

export { parseOpusClipList, classifyStage, OpusClipParseError } from "./opusclip.js";

// Candidate clips: what OpusClip made from a source job, from collection through
// the operator's advisory work (pre-screen, caption, reviewer-requested edits).
// Nothing here can approve, reject or post a clip; transition() refuses those
// moves for any non-reviewer actor anyway.

export type CandidatesErrorCode = "not_found" | "invalid_argument" | "invalid_state" | "conflict" | "caption_invalid";

export class CandidatesError extends Error {
  constructor(
    public readonly code: CandidatesErrorCode,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CandidatesError";
  }
}

export type CandidatesCtx = { db: Db; actor: string; now?: () => Date };

/** A project with no clips this long after it was recorded goes to needs_attention. */
export const MAX_PROCESSING_HOURS = 6;

const COLLECTABLE: readonly SourceJobStatus[] = ["project_created", "processing", "candidates_ready"];

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type CandidateRow = typeof candidateClips.$inferSelect;

async function loadJob(db: Pick<Db, "select">, jobId: string) {
  const [row] = await db
    .select({ job: sourceJobs, campaign: campaigns })
    .from(sourceJobs)
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(sourceJobs.id, jobId));
  if (!row) throw new CandidatesError("not_found", `No source job ${jobId}`);
  return row;
}

async function loadCandidate(db: Pick<Db, "select">, id: string) {
  const [row] = await db
    .select({ clip: candidateClips, job: sourceJobs, campaign: campaigns })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(candidateClips.id, id));
  if (!row) throw new CandidatesError("not_found", `No candidate ${id}`);
  return row;
}

function confirmedConfig(campaign: typeof campaigns.$inferSelect): CampaignConfig {
  if (!campaign.configConfirmedAt) {
    throw new CandidatesError("invalid_state", `Campaign "${campaign.title}" has no confirmed config`);
  }
  return validateCampaignConfig(campaign.config);
}

/** When the job's project was recorded (its latest move to project_created). */
async function projectRecordedAt(db: Pick<Db, "select">, jobId: string): Promise<Date | undefined> {
  const [row] = await db
    .select({ at: statusEvents.createdAt })
    .from(statusEvents)
    .where(and(eq(statusEvents.entityType, "source_job"), eq(statusEvents.entityId, jobId), eq(statusEvents.toStatus, "project_created")))
    .orderBy(desc(statusEvents.createdAt))
    .limit(1);
  return row?.at;
}

const fields = (c: OpusClip) => ({
  title: c.title ?? null,
  description: c.description ?? null,
  hashtags: c.hashtags ?? null,
  durationMs: c.durationMs ?? null,
  previewUrl: c.previewUrl ?? null,
  thumbnailUrl: c.thumbnailUrl ?? null,
  opusclipScore: c.score === undefined ? null : String(c.score),
  opusclipSubScores: c.subScores ?? null,
});

const summarizeChecks = (checks: CheckResults) =>
  Object.entries(checks)
    .map(([k, v]) => `${k}=${v}`)
    .join(", ");

// --- upsert ----------------------------------------------------------------------

/**
 * Stores an `opusclip_list_clips` result for a job: one candidate per OpusClip
 * clip ID however often it's repeated, objective checks run, new candidates in
 * `awaiting_review`. Moves the job along by the project's stage:
 * clips + done → candidates_ready; failed → needs_attention; nothing yet →
 * processing, or needs_attention after MAX_PROCESSING_HOURS.
 */
export async function upsertCandidates(ctx: CandidatesCtx, jobId: string, input: unknown) {
  let list;
  try {
    list = parseOpusClipList(input);
  } catch (err) {
    if (err instanceof OpusClipParseError) throw new CandidatesError("invalid_argument", `Not an opusclip_list_clips result: ${err.message}`);
    throw err;
  }
  const { job, campaign } = await loadJob(ctx.db, jobId);
  if (!COLLECTABLE.includes(job.status)) {
    throw new CandidatesError("invalid_state", `Job ${jobId} is ${job.status}; clips are collected only for ${COLLECTABLE.join(", ")} jobs`);
  }
  const projectId = job.opusclipProjectId;
  if (!projectId) throw new CandidatesError("invalid_state", `Job ${jobId} has no OpusClip project recorded`);
  const foreign = [list.projectId, ...list.clips.map((c) => c.projectId)].find((p) => p && p !== projectId);
  if (foreign) throw new CandidatesError("invalid_argument", `These clips belong to project ${foreign}, not job ${jobId}'s project ${projectId}`);
  const ids = list.clips.map((c) => c.clipId);
  const dup = ids.find((clipId, i) => ids.indexOf(clipId) !== i);
  if (dup) throw new CandidatesError("invalid_argument", `Clip ${dup} appears twice in the result`);
  const config = confirmedConfig(campaign);

  const now = ctx.now?.() ?? new Date();
  const stage = classifyStage(list.stage, list.clips.length);

  return ctx.db.transaction(async (tx) => {
    const existing = ids.length
      ? await tx.select().from(candidateClips).where(inArray(candidateClips.opusclipClipId, ids))
      : [];
    const byClipId = new Map(existing.map((r) => [r.opusclipClipId, r]));
    const created: CandidateRow[] = [];
    const refreshed: CandidateRow[] = [];

    for (const clip of list.clips) {
      const checks = runObjectiveChecks(clip, config);
      const prior = byClipId.get(clip.clipId);
      if (prior) {
        if (prior.sourceJobId !== job.id) {
          throw new CandidatesError("conflict", `Clip ${clip.clipId} is already stored for another source job (${prior.sourceJobId})`);
        }
        // Keep what later steps established (a validated caption) over the fresh default.
        const merged: CheckResults = { ...checks, ...(prior.checkResults?.[CAPTION_CHECK] ? { [CAPTION_CHECK]: prior.checkResults[CAPTION_CHECK] } : {}) };
        const [row] = await tx
          .update(candidateClips)
          .set({ ...fields(clip), checkResults: merged })
          .where(eq(candidateClips.id, prior.id))
          .returning();
        refreshed.push(row!);
        continue;
      }
      const [row] = await tx
        .insert(candidateClips)
        .values({ sourceJobId: job.id, opusclipClipId: clip.clipId, ...fields(clip), checkResults: checks, status: "awaiting_review" })
        .returning();
      await recordCreated(tx, {
        entity: "candidate_clip",
        id: row!.id,
        status: "awaiting_review",
        actor: ctx.actor,
        reason: `collected from OpusClip project ${projectId}; checks: ${summarizeChecks(checks)}`,
      });
      created.push(row!);
    }

    const jobStatus = await advanceJob(ctx, tx, job, list.stage, stage, list.clips.length, now);
    await audit(tx, {
      entityType: "source_job",
      entityId: job.id,
      action: "collect_clips",
      actor: ctx.actor,
      details: { projectId, stage: list.stage ?? null, clips: list.clips.length, created: created.length, refreshed: refreshed.length },
    });

    return {
      jobId: job.id,
      projectId,
      stage: list.stage ?? null,
      stageKind: stage,
      jobStatus,
      created: created.length,
      refreshed: refreshed.length,
      candidates: [...created, ...refreshed].map((r) => ({
        id: r.id,
        opusclipClipId: r.opusclipClipId,
        status: r.status,
        title: r.title,
        durationMs: r.durationMs,
        checkResults: r.checkResults,
        isNew: created.includes(r),
      })),
    };
  });
}

async function advanceJob(
  ctx: CandidatesCtx,
  tx: Tx,
  job: typeof sourceJobs.$inferSelect,
  rawStage: string | undefined,
  stage: ReturnType<typeof classifyStage>,
  clipCount: number,
  now: Date,
): Promise<SourceJobStatus> {
  const stageText = rawStage ?? "(none)";
  await tx.update(sourceJobs).set({ opusclipStage: rawStage ?? null }).where(eq(sourceJobs.id, job.id));
  const move = async (to: SourceJobStatus, reason: string) => {
    if (job.status === to) return to;
    await transition(tx, { entity: "source_job", id: job.id, to, actor: ctx.actor, reason });
    return to;
  };

  if (job.status === "candidates_ready") return job.status; // already collected; this was a refresh
  if (stage === "failed") return move("needs_attention", `OpusClip project stage "${stageText}" with ${clipCount} clips`);
  if (clipCount > 0 && stage === "done") return move("candidates_ready", `${clipCount} clips collected (stage ${stageText})`);
  if (clipCount > 0) return move("processing", `${clipCount} clips so far; project still at stage ${stageText}`);
  if (stage === "done") return move("needs_attention", `OpusClip project finished (stage ${stageText}) with no clips`);

  const since = (await projectRecordedAt(tx, job.id)) ?? job.updatedAt;
  const hours = (now.getTime() - since.getTime()) / 3_600_000;
  if (hours > MAX_PROCESSING_HOURS) {
    return move("needs_attention", `no clips ${Math.floor(hours)}h after the project was recorded (stage ${stageText}); limit is ${MAX_PROCESSING_HOURS}h`);
  }
  return move("processing", `no clips yet (stage ${stageText})`);
}

// --- list ------------------------------------------------------------------------

export async function listCandidates(db: Db, filter: { status?: string; campaignId?: string; jobId?: string } = {}) {
  if (filter.status && !(CANDIDATE_CLIP_STATUSES as readonly string[]).includes(filter.status)) {
    throw new CandidatesError("invalid_argument", `Unknown status ${filter.status}; one of ${CANDIDATE_CLIP_STATUSES.join(", ")}`);
  }
  const rows = await db
    .select({ clip: candidateClips, job: sourceJobs, campaignTitle: campaigns.title })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(
      and(
        filter.status ? eq(candidateClips.status, filter.status as CandidateClipStatus) : undefined,
        filter.campaignId ? eq(sourceJobs.campaignId, filter.campaignId) : undefined,
        filter.jobId ? eq(candidateClips.sourceJobId, filter.jobId) : undefined,
      ),
    )
    .orderBy(asc(candidateClips.createdAt));
  return {
    candidates: rows.map(({ clip, job, campaignTitle }) => ({
      id: clip.id,
      status: clip.status,
      campaignId: job.campaignId,
      campaign: campaignTitle,
      sourceJobId: job.id,
      source: job.sourceName,
      opusclipProjectId: job.opusclipProjectId,
      opusclipClipId: clip.opusclipClipId,
      title: clip.title,
      description: clip.description,
      hashtags: clip.hashtags,
      durationMs: clip.durationMs,
      score: clip.opusclipScore === null ? null : Number(clip.opusclipScore),
      subScores: clip.opusclipSubScores,
      previewUrl: clip.previewUrl,
      thumbnailUrl: clip.thumbnailUrl,
      checkResults: clip.checkResults,
      prescreen: clip.prescreenVerdict ? { verdict: clip.prescreenVerdict, notes: clip.prescreenNotes, at: clip.prescreenedAt } : null,
      caption: clip.caption,
      reviewNotes: clip.reviewNotes,
      edits: clip.editLog.length,
      exportUrl: clip.exportUrl,
    })),
  };
}

// --- operator's advisory work ------------------------------------------------------

/** Records the operator's pre-screen verdict. Advisory: it changes no status. */
export async function prescreenCandidate(ctx: CandidatesCtx, id: string, verdict: string, notes: string) {
  if (!(PRESCREEN_VERDICTS as readonly string[]).includes(verdict)) {
    throw new CandidatesError("invalid_argument", `--verdict must be one of ${PRESCREEN_VERDICTS.join(", ")}`);
  }
  if (!notes.trim()) throw new CandidatesError("invalid_argument", "--notes is required: say what you judged and why");
  const { clip } = await loadCandidate(ctx.db, id);
  if (clip.status !== "awaiting_review") {
    throw new CandidatesError("invalid_state", `Candidate ${id} is ${clip.status}; only awaiting_review candidates are pre-screened`);
  }
  const at = ctx.now?.() ?? new Date();
  return ctx.db.transaction(async (tx) => {
    await tx
      .update(candidateClips)
      .set({ prescreenVerdict: verdict as PrescreenVerdict, prescreenNotes: notes.trim(), prescreenedAt: at })
      .where(eq(candidateClips.id, id));
    await audit(tx, {
      entityType: "candidate_clip",
      entityId: id,
      action: "prescreen",
      actor: ctx.actor,
      details: { verdict, notes: notes.trim(), previous: clip.prescreenVerdict },
    });
    return { id, status: clip.status, prescreen: { verdict, notes: notes.trim(), at } };
  });
}

/** Stores a caption only if it meets every caption rule in the campaign's confirmed config. */
export async function setCaption(ctx: CandidatesCtx, id: string, caption: string) {
  const { clip, campaign } = await loadCandidate(ctx.db, id);
  if (clip.status !== "awaiting_review" && clip.status !== "needs_edit") {
    throw new CandidatesError("invalid_state", `Candidate ${id} is ${clip.status}; captions are set only before a person decides (awaiting_review or needs_edit)`);
  }
  const config = confirmedConfig(campaign);
  const text = caption.replace(/\r\n/g, "\n").trim();
  const result = validateCaption(text, config);
  if (!result.valid) {
    throw new CandidatesError("caption_invalid", `Caption breaks ${result.issues.length} rule${result.issues.length === 1 ? "" : "s"}: ${result.issues.map((i) => i.message).join("; ")}`, {
      issues: result.issues satisfies CaptionIssue[],
    });
  }
  const checkResults: CheckResults = { ...(clip.checkResults ?? {}), [CAPTION_CHECK]: "pass" };
  return ctx.db.transaction(async (tx) => {
    await tx.update(candidateClips).set({ caption: text, checkResults }).where(eq(candidateClips.id, id));
    await audit(tx, { entityType: "candidate_clip", entityId: id, action: "set_caption", actor: ctx.actor, details: { caption: text, previous: clip.caption } });
    return { id, status: clip.status, caption: text, additionalHashtags: result.additionalHashtags, checkResults };
  });
}

/**
 * Logs an `opusclip_edit_clip` call the operator made because a reviewer asked
 * for it, and hands the clip back to the reviewer (needs_edit → awaiting_review).
 */
export async function recordEdit(ctx: CandidatesCtx, id: string, ops: unknown, reason: string) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new CandidatesError("invalid_argument", "ops must be the non-empty ops array passed to opusclip_edit_clip");
  }
  if (!reason.trim()) throw new CandidatesError("invalid_argument", "--reason is required: the reviewer's note and what you changed");
  const { clip } = await loadCandidate(ctx.db, id);
  if (clip.status !== "needs_edit") {
    throw new CandidatesError("invalid_state", `Candidate ${id} is ${clip.status}; edits are recorded only for candidates a reviewer marked needs_edit`);
  }
  const entry = { ops, reason: reason.trim(), at: (ctx.now?.() ?? new Date()).toISOString() };
  const editLog = [...clip.editLog, entry];
  await transition(ctx.db, {
    entity: "candidate_clip",
    id,
    to: "awaiting_review",
    actor: ctx.actor,
    reason: `edited as requested: ${entry.reason}`,
    expectFrom: ["needs_edit"],
    set: { editLog },
  });
  return { id, status: "awaiting_review" as const, edit: entry, edits: editLog.length };
}
