import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import {
  CANDIDATE_CLIP_STATUSES,
  PRESCREEN_VERDICTS,
  campaigns,
  candidateClips,
  sourceJobs,
  statusEvents,
  CHECK_OUTCOMES,
  type CandidateClipStatus,
  type PrescreenVerdict,
  type SourceJobStatus,
  type VisualReview,
} from "../../db/schema.js";
import { isHumanActor, recordCreated, STANDING_RULES, transition } from "../../db/transition.js";
import { loadJobWithCampaign, loadCandidateWithContext } from "../../db/helpers.js";
import { validateCampaignConfig, type CampaignConfig } from "../campaign-config/index.js";
import {
  CAPTION_CHECK,
  ENGLISH_CHECK,
  runObjectiveChecks,
  validateCaption,
  visualCheckNames,
  type CaptionIssue,
  type CheckResults,
} from "../compliance/index.js";
import { classifyStage, OpusClipParseError, parseOpusClipList, type OpusClip } from "./opusclip.js";

export { parseOpusClipList, classifyStage, OpusClipParseError } from "./opusclip.js";

// Candidate clips: what OpusClip made from a source job, from collection through
// the operator's advisory work (pre-screen, caption, reviewer-requested edits).
// Nothing here can approve or post a clip; transition() refuses those moves for
// any non-reviewer actor anyway. Rejecting is the one exception: a reviewer can,
// and the operator can when a named person asks for it (rejectCandidates).

export type CandidatesErrorCode = "not_found" | "invalid_argument" | "invalid_state" | "conflict" | "caption_invalid" | "visual_review_required";

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
  const row = await loadJobWithCampaign(db, jobId);
  if (!row) throw new CandidatesError("not_found", `No source job ${jobId}`);
  return row;
}

async function loadCandidate(db: Pick<Db, "select">, id: string) {
  const row = await loadCandidateWithContext(db, id);
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

/** A visual review describes the render it looked at; any edit since makes it stale. */
const currentVisualReview = (clip: CandidateRow): VisualReview | null =>
  clip.visualReview && clip.visualReview.edits === clip.editLog.length ? clip.visualReview : null;

/** Results a refresh must not reset: the caption check, and a current visual review's checks. */
function keptResults(prior: CandidateRow): CheckResults {
  const kept: CheckResults = {};
  const caption = prior.checkResults?.[CAPTION_CHECK];
  if (caption) kept[CAPTION_CHECK] = caption;
  const visual = currentVisualReview(prior);
  for (const name of Object.keys(visual?.checks ?? {})) {
    const outcome = prior.checkResults?.[name];
    if (outcome) kept[name] = outcome;
  }
  return kept;
}

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
  const foreign = list.clips.map((c) => c.projectId).find((p) => p && p !== projectId);
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
        // Keep what later steps established (a validated caption, a current visual review) over the fresh defaults.
        const merged: CheckResults = { ...checks, ...keptResults(prior) };
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

export async function listCandidates(db: Db, filter: { status?: string; campaignId?: string; jobId?: string; id?: string } = {}) {
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
        filter.id ? eq(candidateClips.id, filter.id) : undefined,
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
      visualReview: currentVisualReview(clip),
      caption: clip.caption,
      reviewNotes: clip.reviewNotes,
      edits: clip.editLog.length,
      exportUrl: clip.exportUrl,
    })),
  };
}

/**
 * One candidate, as `listCandidates` describes it, plus the checks its visual
 * review has to cover (empty when the campaign has no confirmed config).
 */
export async function showCandidate(db: Db, id: string) {
  if (!z.uuid().safeParse(id).success) throw new CandidatesError("invalid_argument", `${id} isn't a candidate ID`);
  const [candidate] = (await listCandidates(db, { id })).candidates;
  if (!candidate) throw new CandidatesError("not_found", `No candidate ${id}`);
  const { clip, campaign } = await loadCandidate(db, id);
  const visualChecks = campaign.configConfirmedAt
    ? visualCheckNames(runObjectiveChecks({ durationMs: clip.durationMs ?? undefined }, confirmedConfig(campaign)))
    : [];
  return { ...candidate, visualChecks };
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
  // Recommending or holding a clip vouches for what's on screen, so it needs a look at
  // this render's frames first. A reject needs no look (a failed duration check is enough).
  if (verdict !== "reject" && !currentVisualReview(clip)) {
    throw new CandidatesError(
      "visual_review_required",
      `Candidate ${id} has no visual review${clip.visualReview ? " of its current render (it was edited since)" : ""}. Run \`clipper candidate frames ${id}\`, look at the frames, record \`clipper candidate visual-review ${id}\`, then pre-screen.`,
    );
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

const REJECTABLE: readonly CandidateClipStatus[] = ["awaiting_review", "needs_edit"];

/**
 * Rejects clips a person doesn't want: the listed ones, or every clip of a
 * campaign still waiting on a decision (awaiting_review or needs_edit). A
 * reviewer does it from the review page; the operator only with `requestedBy`,
 * the person who asked. All or nothing: one listed clip that can't be rejected stops the lot.
 */
export async function rejectCandidates(
  ctx: CandidatesCtx,
  target: { ids?: string[]; campaignId?: string },
  reason: string,
  requestedBy?: string,
) {
  const why = reason.trim();
  if (!why) throw new CandidatesError("invalid_argument", "A reason is required: say why the clips are rejected");
  const by = requestedBy?.trim();
  if (!isHumanActor(ctx.actor) && !by) {
    throw new CandidatesError("invalid_argument", "Say who asked for this (--requested-by <name>): the operator rejects clips only when a person asks");
  }
  const ids = target.ids ?? [];
  if (!ids.length === !target.campaignId) throw new CandidatesError("invalid_argument", "Give candidate IDs or a campaign (exactly one of them)");

  const rows = await ctx.db
    .select({ id: candidateClips.id, status: candidateClips.status })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .where(target.campaignId ? eq(sourceJobs.campaignId, target.campaignId) : inArray(candidateClips.id, ids))
    .orderBy(asc(candidateClips.createdAt));
  const missing = ids.filter((id) => !rows.some((r) => r.id === id));
  if (missing.length) throw new CandidatesError("not_found", `No candidate ${missing.join(", ")}`);
  const open = rows.filter((r) => REJECTABLE.includes(r.status));
  if (ids.length && open.length < rows.length) {
    const bad = rows.filter((r) => !REJECTABLE.includes(r.status)).map((r) => `${r.id} (${r.status})`);
    throw new CandidatesError("invalid_state", `Only clips waiting on a decision (${REJECTABLE.join(" or ")}) can be rejected: ${bad.join(", ")}`);
  }

  const statusReason = by ? `${why} (requested by ${by})` : why;
  await ctx.db.transaction(async (tx) => {
    for (const r of open) {
      await transition(tx, {
        entity: "candidate_clip",
        id: r.id,
        to: "rejected",
        actor: ctx.actor,
        reason: statusReason,
        requestedBy: by,
        expectFrom: REJECTABLE,
        set: { reviewNotes: why },
      });
    }
  });
  return { rejected: open.map((r) => r.id), count: open.length, reason: statusReason };
}

/**
 * The standing rule (2026-09-27): the operator rejects, without anyone asking
 * each time, every clip still waiting on a decision that has a recorded failed
 * check (code's, or a visual review's with evidence) AND the operator's own
 * pre-screen verdict of reject. A held clip with a failed check (e.g. waiting
 * on a caption fix) is left alone, and so is anything rejected on taste alone.
 * Rejects are final, as any reject is.
 */
export async function rejectFailedCandidates(ctx: CandidatesCtx, filter: { campaignId?: string } = {}) {
  const rows = await ctx.db
    .select({ clip: candidateClips })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .where(and(inArray(candidateClips.status, [...REJECTABLE]), filter.campaignId ? eq(sourceJobs.campaignId, filter.campaignId) : undefined))
    .orderBy(asc(candidateClips.createdAt));

  const evidence = (clip: CandidateRow, name: string) => {
    if (name === "duration" && clip.durationMs !== null) return `duration (${Math.round(clip.durationMs / 1000)}s is outside the campaign's limits)`;
    if (name === ENGLISH_CHECK && !currentVisualReview(clip)?.checks[name]) return `${name} (OpusClip wrote this clip's title and description in another language: "${clip.title ?? ""}")`;
    const seen = currentVisualReview(clip)?.checks[name]?.evidence;
    return seen ? `${name} (${seen})` : name;
  };

  const rejected: { id: string; failed: string[]; reason: string }[] = [];
  const keptWithFailures: { id: string; failed: string[]; verdict: string | null }[] = [];
  await ctx.db.transaction(async (tx) => {
    for (const { clip } of rows) {
      const failed = failedChecksOf(clip);
      if (!failed.length) continue;
      if (clip.prescreenVerdict !== "reject") {
        keptWithFailures.push({ id: clip.id, failed, verdict: clip.prescreenVerdict });
        continue;
      }
      const reason = `Failed ${failed.map((n) => evidence(clip, n)).join("; ")}`;
      await transition(tx, {
        entity: "candidate_clip",
        id: clip.id,
        to: "rejected",
        actor: ctx.actor,
        reason: `${reason} (${STANDING_RULES.reject_failed_checks})`,
        standingRule: "reject_failed_checks",
        expectFrom: REJECTABLE,
        set: { reviewNotes: reason },
      });
      rejected.push({ id: clip.id, failed, reason });
    }
  });
  return { rejected, count: rejected.length, keptWithFailures };
}

// --- automatic fixes ---------------------------------------------------------------

/**
 * opusclip_edit_clip ops the operator may use to fix a failed check on its own
 * (standing rule, 2026-09-27). They correct or cut what's there; nothing that
 * adds content (text overlays, emoji) or hides a problem (turning captions off).
 */
export const AUTO_FIX_OPS = [
  "replace_phrase",
  "delete_phrase",
  "remove_filler_words",
  "remove_pauses",
  "trim_section",
  "split_section",
  "drop_section",
  "reorder_sections",
  "set_style",
  "undo",
] as const;

/** Automatic fixes per clip; after that it's the reviewer's (or the reject rule's) call. */
export const MAX_AUTO_FIXES = 2;

const failedChecksOf = (clip: CandidateRow) =>
  Object.entries(clip.checkResults ?? {})
    .filter(([, outcome]) => outcome === "fail")
    .map(([name]) => name);

const autoFixCount = (clip: CandidateRow) => clip.editLog.filter((e) => e.fixes?.length).length;

/** Why an automatic fix with these ops isn't allowed on this clip, or null when it is. */
function autoFixRefusal(clip: CandidateRow, ops: unknown[]): string | null {
  if (clip.status !== "awaiting_review") return `it's ${clip.status}; automatic fixes are only for clips awaiting review`;
  if (!failedChecksOf(clip).length) return "it has no failed check to fix";
  const bad = ops.map((o) => (o as { op?: unknown })?.op).filter((op) => !(AUTO_FIX_OPS as readonly unknown[]).includes(op));
  if (bad.length) return `ops ${bad.map(String).join(", ")} aren't allowed in an automatic fix (allowed: ${AUTO_FIX_OPS.join(", ")})`;
  if (autoFixCount(clip) >= MAX_AUTO_FIXES) return `it already had ${MAX_AUTO_FIXES} automatic fixes`;
  return null;
}

export type EditGuardVerdict = { allow: boolean; reason: string; candidateId?: string };

/**
 * The PreToolUse check behind .claude/hooks/guard-opusclip-edit.sh. Allows an
 * opusclip_edit_clip call when it's a dry run, when a reviewer marked the clip
 * needs_edit, or under the fix rule: a clip awaiting review with a failed check,
 * only fixing ops, at most MAX_AUTO_FIXES times. Anything else is refused.
 */
export async function guardEdit(db: Db, payloadText: string): Promise<EditGuardVerdict> {
  let input: { projectId?: unknown; clipId?: unknown; ops?: unknown; dryRun?: unknown } | undefined;
  try {
    input = (JSON.parse(payloadText) as { tool_input?: typeof input })?.tool_input;
  } catch {
    return { allow: false, reason: "Blocked: hook payload isn't JSON." };
  }
  if (!input || typeof input !== "object") return { allow: false, reason: "Blocked: no tool_input in hook payload." };
  if (input.dryRun === true) return { allow: true, reason: "Allowed: dry run changes nothing." };
  if (typeof input.clipId !== "string" || !Array.isArray(input.ops)) return { allow: false, reason: "Blocked: expected clipId and ops." };
  const [row] = await db
    .select({ clip: candidateClips, job: sourceJobs })
    .from(candidateClips)
    .innerJoin(sourceJobs, eq(sourceJobs.id, candidateClips.sourceJobId))
    .where(eq(candidateClips.opusclipClipId, input.clipId));
  if (!row) return { allow: false, reason: `Blocked: clip ${input.clipId} isn't a stored candidate.` };
  if (row.job.opusclipProjectId !== input.projectId) return { allow: false, reason: `Blocked: clip ${input.clipId} belongs to project ${row.job.opusclipProjectId}.`, candidateId: row.clip.id };
  if (row.clip.status === "needs_edit") return { allow: true, reason: "Allowed: a reviewer asked for edits (needs_edit).", candidateId: row.clip.id };
  const refusal = autoFixRefusal(row.clip, input.ops);
  if (refusal) return { allow: false, reason: `Blocked: can't edit candidate ${row.clip.id}: ${refusal}.`, candidateId: row.clip.id };
  return { allow: true, reason: `Allowed: automatic fix of ${failedChecksOf(row.clip).join(", ")}.`, candidateId: row.clip.id };
}

/**
 * Logs an `opusclip_edit_clip` call the operator made because a reviewer asked
 * for it, and hands the clip back to the reviewer (needs_edit → awaiting_review).
 */
export async function recordEdit(ctx: CandidatesCtx, id: string, ops: unknown, reason: string, fixes: string[] = []) {
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new CandidatesError("invalid_argument", "ops must be the non-empty ops array passed to opusclip_edit_clip");
  }
  if (!reason.trim()) throw new CandidatesError("invalid_argument", "--reason is required: what was wrong and what you changed");
  const { clip } = await loadCandidate(ctx.db, id);
  const at = (ctx.now?.() ?? new Date()).toISOString();
  // The render changed, so what the last visual review saw no longer holds: its checks go back to the reviewer.
  const checkResults: CheckResults = { ...(clip.checkResults ?? {}) };
  for (const name of Object.keys(clip.visualReview?.checks ?? {})) checkResults[name] = "manual_review_required";

  if (clip.status === "needs_edit") {
    const entry = { ops, reason: reason.trim(), at };
    const editLog = [...clip.editLog, entry];
    await transition(ctx.db, {
      entity: "candidate_clip",
      id,
      to: "awaiting_review",
      actor: ctx.actor,
      reason: `edited as requested: ${entry.reason}`,
      expectFrom: ["needs_edit"],
      set: { editLog, checkResults, visualReview: null },
    });
    return { id, status: "awaiting_review" as const, edit: entry, edits: editLog.length };
  }

  // Standing rule (2026-09-27): the operator may fix a clip's failed checks without being asked.
  if (!fixes.length) {
    throw new CandidatesError(
      "invalid_state",
      `Candidate ${id} is ${clip.status}; record an edit either for a reviewer's needs_edit, or as an automatic fix naming the failed checks it fixes (--fixes)`,
    );
  }
  const refusal = autoFixRefusal(clip, ops);
  if (refusal) throw new CandidatesError("invalid_state", `Can't record an automatic fix on ${id}: ${refusal}`);
  const failed = failedChecksOf(clip);
  const notFailed = fixes.filter((n) => !failed.includes(n));
  if (notFailed.length) throw new CandidatesError("invalid_argument", `--fixes names checks that didn't fail: ${notFailed.join(", ")} (failed: ${failed.join(", ")})`);
  for (const name of fixes) checkResults[name] = "manual_review_required";
  const entry = { ops, reason: reason.trim(), at, fixes };
  const editLog = [...clip.editLog, entry];
  return ctx.db.transaction(async (tx) => {
    // The old verdict described the old render; the fixed clip gets looked at and pre-screened afresh.
    await tx
      .update(candidateClips)
      .set({ editLog, checkResults, visualReview: null, prescreenVerdict: null, prescreenNotes: null, prescreenedAt: null })
      .where(eq(candidateClips.id, id));
    await audit(tx, { entityType: "candidate_clip", entityId: id, action: "auto_fix", actor: ctx.actor, details: { ...entry, previousVerdict: clip.prescreenVerdict } });
    return { id, status: clip.status, edit: entry, edits: editLog.length, autoFixes: autoFixCount(clip) + 1 };
  });
}

// --- visual review ------------------------------------------------------------------

const visualReviewSchema = z.strictObject({
  framesChecked: z.number().int().positive(),
  summary: z.string().trim().min(1),
  checks: z.record(
    z.string(),
    z.strictObject({ result: z.enum(CHECK_OUTCOMES), evidence: z.string().trim().min(1) }),
  ),
});

export type VisualReviewInput = z.infer<typeof visualReviewSchema>;

/**
 * Records what the operator saw in a clip's frames (`candidate frames`): a result
 * and evidence for every check the clip data couldn't settle, and nothing else.
 * Duration and the caption stay code's; a check that still can't be judged from
 * frames stays `manual_review_required`, with evidence saying why. A failed check
 * then needs the reviewer's explicit override to approve, as any failed check does.
 */
export async function recordVisualReview(ctx: CandidatesCtx, id: string, input: unknown) {
  const parsed = visualReviewSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new CandidatesError("invalid_argument", `Visual review: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const review = parsed.data;
  const { clip, campaign } = await loadCandidate(ctx.db, id);
  if (clip.status !== "awaiting_review" && clip.status !== "needs_edit") {
    throw new CandidatesError("invalid_state", `Candidate ${id} is ${clip.status}; visual reviews are recorded only before a person decides (awaiting_review or needs_edit)`);
  }
  const config = confirmedConfig(campaign);
  const expected = visualCheckNames(runObjectiveChecks({ durationMs: clip.durationMs ?? undefined }, config));
  const given = Object.keys(review.checks);
  const missing = expected.filter((n) => !given.includes(n));
  const unknown = given.filter((n) => !expected.includes(n));
  if (missing.length || unknown.length) {
    throw new CandidatesError(
      "invalid_argument",
      [
        missing.length ? `missing ${missing.join(", ")}` : "",
        unknown.length ? `not a visual check here: ${unknown.join(", ")} (duration and the caption are checked by code)` : "",
      ]
        .filter(Boolean)
        .join("; "),
      { expected },
    );
  }

  const record: VisualReview = {
    at: (ctx.now?.() ?? new Date()).toISOString(),
    actor: ctx.actor,
    framesChecked: review.framesChecked,
    summary: review.summary,
    edits: clip.editLog.length,
    checks: review.checks,
  };
  const checkResults: CheckResults = { ...(clip.checkResults ?? {}) };
  for (const [name, { result }] of Object.entries(review.checks)) checkResults[name] = result;
  const failed = Object.entries(review.checks).filter(([, c]) => c.result === "fail").map(([n]) => n);

  return ctx.db.transaction(async (tx) => {
    await tx.update(candidateClips).set({ visualReview: record, checkResults }).where(eq(candidateClips.id, id));
    await audit(tx, {
      entityType: "candidate_clip",
      entityId: id,
      action: "visual_review",
      actor: ctx.actor,
      details: { ...record, previous: clip.visualReview },
    });
    return { id, status: clip.status, failed, checkResults, visualReview: record };
  });
}
