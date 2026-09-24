import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { audit } from "../../db/audit.js";
import { campaigns, creditLedger, sourceJobs, type FootageKind } from "../../db/schema.js";
import { transition } from "../../db/transition.js";
import { validateCampaignConfig } from "../campaign-config/index.js";
import { estimateCredits, lockBudget, usedToday } from "../credits/index.js";
import { needsUpload } from "./upload.js";

export { driveDownloadUrl, needsUpload, UploadError, uploadSource, type UploadInput } from "./upload.js";

// The "record first, then spend" protocol (docs/ARCHITECTURE.md). The database
// decides whether an OpusClip submission may happen and with exactly which
// parameters; the operator's connector call only carries that decision out, and
// the PreToolUse hook (guardSubmit) refuses any call that doesn't match.

export type SubmissionErrorCode =
  | "not_found"
  | "invalid_state"
  | "invalid_argument"
  | "budget_exceeded"
  | "conflict"
  | "fetch_failed";

export class SubmissionError extends Error {
  constructor(
    public readonly code: SubmissionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SubmissionError";
  }
}

export type SubmitCtx = { db: Db; actor: string; fetch?: typeof fetch; dailyBudget?: number };

export const MAX_SUBMIT_RETRIES = 3;
export const submitTitle = (jobId: string) => `clipper:${jobId}`;

async function loadJob(db: Db, jobId: string) {
  const [row] = await db
    .select({ job: sourceJobs, campaign: campaigns })
    .from(sourceJobs)
    .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
    .where(eq(sourceJobs.id, jobId));
  if (!row) throw new SubmissionError("not_found", `No source job ${jobId}`);
  return row;
}

function requireActiveCampaign(c: typeof campaigns.$inferSelect) {
  if (c.status !== "active" || !c.configConfirmedAt) {
    throw new SubmissionError(
      "invalid_state",
      `Campaign "${c.title}" is ${c.status}${c.configConfirmedAt ? "" : " with no confirmed config"}; a person has to confirm it before anything is submitted.`,
    );
  }
}

// --- validate --------------------------------------------------------------------

export type Reachability = { reachable: boolean; status: number | null; reason?: string };

/** Anonymous check that OpusClip will be able to fetch the video. Throws fetch_failed on network errors (no verdict). */
export async function checkReachable(kind: FootageKind, url: string, fetchImpl: typeof fetch = fetch): Promise<Reachability> {
  let probe = url;
  let method = "GET";
  if (kind === "youtube_video") probe = `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`;
  if (kind === "s3_mp4") method = "HEAD";
  let res: Response;
  try {
    res = await fetchImpl(probe, { method, redirect: "follow", signal: AbortSignal.timeout(20_000), headers: { "user-agent": "Mozilla/5.0" } });
  } catch (err) {
    throw new SubmissionError("fetch_failed", `Couldn't reach ${url}: ${(err as Error).message}`);
  }
  let host = "";
  try {
    host = new URL(res.url || probe).hostname;
  } catch {
    // keep empty
  }
  if (/(^|\.)accounts\.google\.com$/.test(host)) return { reachable: false, status: res.status, reason: "requires Google sign-in (not shared publicly)" };
  if (res.status === 401 || res.status === 403) return { reachable: false, status: res.status, reason: "private or access-restricted" };
  if (res.status === 404 || res.status === 410) return { reachable: false, status: res.status, reason: "not found (deleted or wrong link)" };
  if (!res.ok) return { reachable: false, status: res.status, reason: `HTTP ${res.status}` };
  return { reachable: true, status: res.status };
}

/**
 * Checks a selected video can be submitted: campaign confirmed + active, source
 * publicly reachable. Also re-queues a submit_failed job once its cause is fixed;
 * that drops any earlier OpusClip upload so the video is uploaded afresh.
 */
export async function validateSource(ctx: SubmitCtx, jobId: string) {
  const { job, campaign } = await loadJob(ctx.db, jobId);
  if (job.decision !== "selected") throw new SubmissionError("invalid_state", `Job ${jobId} was skipped, not selected`);
  if (!["detected", "validation_failed", "submit_failed", "queued"].includes(job.status)) {
    throw new SubmissionError("invalid_state", `Job ${jobId} is ${job.status}; only detected/validation_failed/submit_failed jobs are validated`);
  }
  requireActiveCampaign(campaign);
  if (job.status === "queued") return { id: job.id, status: "queued" as const, alreadyValid: true };

  const check = await checkReachable(job.sourceKind, job.sourceUrl, ctx.fetch);
  if (check.reachable) {
    const retry = job.status === "submit_failed";
    await transition(ctx.db, {
      entity: "source_job",
      id: job.id,
      to: "queued",
      actor: ctx.actor,
      reason: retry ? `source re-validated after submit failure (${job.statusReason ?? "no reason recorded"})` : "source validated",
      ...(retry ? { set: { opusclipUploadId: null } } : {}),
    });
    return { id: job.id, status: "queued" as const, check, ...(needsUpload(job.sourceKind) ? { next: "upload" as const } : {}) };
  }
  const reason = `source_unreachable: ${check.reason}`;
  if (job.status === "detected") {
    await transition(ctx.db, { entity: "source_job", id: job.id, to: "validation_failed", actor: ctx.actor, reason, errorDetails: check });
  }
  return { id: job.id, status: "validation_failed" as const, check, reason };
}

// --- reserve ---------------------------------------------------------------------

export type ReserveInput = { opusRemaining: number; range?: string; estimatedMinutes?: number };

export function parseRange(range: string): { start: number; end: number } {
  const m = range.match(/^(\d+)-(\d+)$/);
  if (!m) throw new SubmissionError("invalid_argument", `--range must be <startSec>-<endSec>, e.g. 0-600`);
  const start = Number(m[1]);
  const end = Number(m[2]);
  if (end <= start) throw new SubmissionError("invalid_argument", "--range end must be after start");
  return { start, end };
}

/** Exactly what the operator passes to opusclip_submit_project. Built only from confirmed config. */
export function buildSubmitParams(
  job: typeof sourceJobs.$inferSelect,
  config: unknown,
  range?: { start: number; end: number },
): Record<string, unknown> {
  const c = validateCampaignConfig(config).clipGeneration;
  return {
    // Drive videos go in through OpusClip's upload link (`source upload`); the rest by URL.
    videoUrl: job.opusclipUploadId ?? job.sourceUrl,
    title: submitTitle(job.id),
    aspectRatio: c.aspectRatio,
    clipDurationsSec: [[c.minDurationSeconds, c.maxDurationSeconds]],
    enableCaption: c.captionsEnabled,
    ...(c.brandTemplateId ? { brandTemplateId: c.brandTemplateId } : {}),
    ...(range ? { rangeStart: range.start, rangeEnd: range.end } : {}),
  };
}

/**
 * Reserves credits for one job and issues its submit parameters. One transaction,
 * serialized by an advisory lock: the job must be queued with no project and no
 * open reservation, and the estimate must fit today's budget, the campaign's cap,
 * and OpusClip's own remaining credits.
 */
export async function reserve(ctx: SubmitCtx, jobId: string, input: ReserveInput) {
  if (!Number.isInteger(input.opusRemaining) || input.opusRemaining < 0) {
    throw new SubmissionError("invalid_argument", "--opus-remaining must be a whole number ≥ 0 (monthly.remaining from opusclip_get_usage)");
  }
  if (ctx.dailyBudget === undefined) throw new SubmissionError("invalid_state", "OPUSCLIP_DAILY_CREDIT_BUDGET isn't configured");
  const range = input.range ? parseRange(input.range) : undefined;
  const credits = estimateCredits({ rangeSeconds: range ? range.end - range.start : undefined, estimatedMinutes: input.estimatedMinutes });

  return ctx.db.transaction(async (tx) => {
    await lockBudget(tx);
    const { job, campaign } = await loadJob(tx as unknown as Db, jobId);
    requireActiveCampaign(campaign);
    if (job.status !== "queued") {
      throw new SubmissionError("invalid_state", `Job ${jobId} is ${job.status}; only queued jobs can be reserved (run \`source validate\` first)`);
    }
    if (job.opusclipProjectId) throw new SubmissionError("invalid_state", `Job ${jobId} already has OpusClip project ${job.opusclipProjectId}`);
    if (needsUpload(job.sourceKind) && !job.opusclipUploadId) {
      throw new SubmissionError(
        "invalid_state",
        `Job ${jobId} is a Google Drive file, which OpusClip won't fetch by link; upload it first (opusclip_create_upload_link, then \`source upload\`)`,
      );
    }

    const today = await usedToday(tx, undefined);
    const campaignToday = await usedToday(tx, campaign.id);
    const budget = { credits, dailyBudget: ctx.dailyBudget!, usedToday: today, campaignCap: campaign.maxDailyCredits, campaignUsedToday: campaignToday, opusRemaining: input.opusRemaining };
    if (today + credits > ctx.dailyBudget!) {
      throw new SubmissionError("budget_exceeded", `Needs ${credits} credits; ${ctx.dailyBudget! - today} of today's ${ctx.dailyBudget} left`);
    }
    if (campaign.maxDailyCredits !== null && campaignToday + credits > campaign.maxDailyCredits) {
      throw new SubmissionError("budget_exceeded", `Needs ${credits} credits; campaign cap leaves ${campaign.maxDailyCredits - campaignToday} today`);
    }
    if (credits > input.opusRemaining) {
      throw new SubmissionError("budget_exceeded", `Needs ${credits} credits; OpusClip reports only ${input.opusRemaining} left this month`);
    }

    let submitParams: Record<string, unknown>;
    try {
      submitParams = buildSubmitParams(job, campaign.config, range);
    } catch {
      throw new SubmissionError("invalid_state", `Campaign "${campaign.title}" has no valid confirmed config`);
    }
    const [reservation] = await tx
      .insert(creditLedger)
      .values({ sourceJobId: job.id, campaignId: campaign.id, creditsReserved: credits })
      .returning();
    await transition(tx, {
      entity: "source_job",
      id: job.id,
      to: "submitting",
      actor: ctx.actor,
      reason: `reserved ${credits} credits`,
      expectFrom: ["queued"],
      set: { submitParams },
    });
    await audit(tx, { entityType: "credits", entityId: reservation!.id, action: "reserve", actor: ctx.actor, details: { jobId: job.id, ...budget } });
    return { jobId: job.id, reservationId: reservation!.id, credits, submitParams, budget };
  });
}

// --- record ------------------------------------------------------------------------

async function closeReservation(tx: Pick<Db, "update">, jobId: string, to: "consumed" | "released") {
  return tx
    .update(creditLedger)
    .set({ status: to, closedAt: new Date() })
    .where(and(eq(creditLedger.sourceJobId, jobId), eq(creditLedger.status, "open")))
    .returning({ id: creditLedger.id, credits: creditLedger.creditsReserved });
}

/** Records the project OpusClip created for a reserved job. Idempotent for the same project ID. */
export async function recordProject(ctx: SubmitCtx, jobId: string, projectId: string) {
  if (!projectId.trim()) throw new SubmissionError("invalid_argument", "--project-id is required");
  const { job } = await loadJob(ctx.db, jobId);
  if (job.opusclipProjectId === projectId) return { id: job.id, status: job.status, projectId, alreadyRecorded: true };
  if (job.opusclipProjectId) {
    throw new SubmissionError("conflict", `Job ${jobId} already has project ${job.opusclipProjectId}; refusing to record ${projectId}`);
  }
  if (job.status !== "submitting" && job.status !== "needs_attention") {
    throw new SubmissionError("invalid_state", `Job ${jobId} is ${job.status}; only a submitting job gets a project recorded`);
  }
  return ctx.db.transaction(async (tx) => {
    const closed = await closeReservation(tx, job.id, "consumed");
    await transition(tx, {
      entity: "source_job",
      id: job.id,
      to: "project_created",
      actor: ctx.actor,
      reason: `OpusClip project ${projectId}`,
      set: { opusclipProjectId: projectId },
    });
    return { id: job.id, status: "project_created" as const, projectId, creditsConsumed: closed[0]?.credits ?? null };
  });
}

const RETRYABLE = /\b(429|502|503|504)\b|rate.?limit|too many requests|time(d)?.?out|ETIMEDOUT|ECONNRESET|temporar|try again|quota|too many users|unavailable/i;

export function classifyConnectorError(message: string): "retryable" | "permanent" {
  return RETRYABLE.test(message) ? "retryable" : "permanent";
}

/**
 * Records a failed connector submission: releases the reservation, then either
 * re-queues (transient errors, up to MAX_SUBMIT_RETRIES) or stops (permanent).
 */
export async function recordFailure(ctx: SubmitCtx, jobId: string, error: string) {
  if (!error.trim()) throw new SubmissionError("invalid_argument", "--error is required");
  const { job } = await loadJob(ctx.db, jobId);
  if (job.status !== "submitting") throw new SubmissionError("invalid_state", `Job ${jobId} is ${job.status}, not submitting`);
  const kind = classifyConnectorError(error);
  const retries = job.retryCount + (kind === "retryable" ? 1 : 0);
  const to = kind === "permanent" ? "submit_failed" : retries >= MAX_SUBMIT_RETRIES ? "needs_attention" : "queued";
  const reason =
    to === "queued"
      ? `transient submit failure (retry ${retries}/${MAX_SUBMIT_RETRIES})`
      : to === "needs_attention"
        ? `submit failed ${retries} times: ${error.slice(0, 300)}`
        : `submit failed: ${error.slice(0, 300)}`;
  return ctx.db.transaction(async (tx) => {
    const released = await closeReservation(tx, job.id, "released");
    await transition(tx, {
      entity: "source_job",
      id: job.id,
      to,
      actor: ctx.actor,
      reason,
      errorDetails: { error, classification: kind },
      set: { retryCount: retries, submitParams: null },
    });
    return { id: job.id, status: to, classification: kind, retryCount: retries, creditsReleased: released[0]?.credits ?? null };
  });
}

// --- guard -----------------------------------------------------------------------

/** Stable JSON: object keys sorted, so jsonb round-trips compare equal. */
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as object)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export type GuardVerdict = { allow: boolean; reason: string; jobId?: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The PreToolUse check behind .claude/hooks/guard-opusclip-submit.sh. Allows an
 * opusclip_submit_project call only when its title names a job that is
 * `submitting` with an open reservation, and its input equals that job's issued
 * submit_params exactly. Anything else (including malformed input) is refused.
 */
export async function guardSubmit(db: Db, payloadText: string): Promise<GuardVerdict> {
  let payload: { tool_input?: unknown };
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { allow: false, reason: "Blocked: hook payload isn't JSON." };
  }
  const input = payload?.tool_input;
  if (!input || typeof input !== "object") return { allow: false, reason: "Blocked: no tool_input in hook payload." };
  const title = (input as { title?: unknown }).title;
  const jobId = typeof title === "string" && title.startsWith("clipper:") ? title.slice("clipper:".length) : null;
  if (!jobId || !UUID.test(jobId)) {
    return { allow: false, reason: "Blocked: submissions must use the exact params from `clipper source reserve` (title clipper:<jobId>)." };
  }
  const [job] = await db.select().from(sourceJobs).where(eq(sourceJobs.id, jobId));
  if (!job) return { allow: false, reason: `Blocked: no source job ${jobId}.`, jobId };
  const [open] = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(and(eq(creditLedger.sourceJobId, jobId), eq(creditLedger.status, "open")));
  if (job.status !== "submitting" || !open || !job.submitParams) {
    return { allow: false, reason: `Blocked: job ${jobId} is ${job.status} without an open reservation. Run \`clipper source reserve\` first.`, jobId };
  }
  if (canonical(input) !== canonical(job.submitParams)) {
    return {
      allow: false,
      reason: `Blocked: parameters differ from the reservation for job ${jobId}. Call opusclip_submit_project with exactly the submitParams \`reserve\` returned.`,
      jobId,
    };
  }
  return { allow: true, reason: `Allowed: matches open reservation ${open.id}.`, jobId };
}
