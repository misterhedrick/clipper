import { and, asc, eq } from "drizzle-orm";
import { loadConfig } from "../../config.js";
import { campaigns, sourceJobs, SOURCE_JOB_STATUSES, type SourceJobStatus } from "../../db/schema.js";
import { resolveCampaign } from "../../modules/campaigns/index.js";
import { creditsSummary, reconcileUsage } from "../../modules/credits/index.js";
import { recordFailure, recordProject, reserve, validateSource } from "../../modules/submissions/index.js";
import { positional, requiredOption, UsageError, type Command, type CommandContext } from "../run.js";

const submitCtx = (ctx: CommandContext, withBudget = false) => ({
  db: ctx.db(),
  actor: ctx.actor,
  fetch: ctx.connector.fetch,
  ...(withBudget ? { dailyBudget: loadConfig(["credits"], ctx.env).OPUSCLIP_DAILY_CREDIT_BUDGET } : {}),
});

function intOption(ctx: CommandContext, name: string, required: boolean): number | undefined {
  const raw = ctx.options[name];
  if (raw === undefined) {
    if (required) throw new UsageError(`Missing --${name}`);
    return undefined;
  }
  const n = Number(raw);
  if (typeof raw !== "string" || !Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number ≥ 0`);
  return n;
}

export const sourceCommands: Record<string, Command> = {
  list: {
    summary: "(read-only) Source jobs, oldest first.",
    usage: "[--status <status>] [--campaign <id>]",
    options: { status: { type: "string" }, campaign: { type: "string" } },
    run: async (ctx) => {
      const status = ctx.options.status as string | undefined;
      if (status && !(SOURCE_JOB_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`Unknown status ${status}; one of ${SOURCE_JOB_STATUSES.join(", ")}`);
      }
      const db = ctx.db();
      const campaignId = ctx.options.campaign ? (await resolveCampaign(db, ctx.options.campaign as string)).id : undefined;
      const rows = await db
        .select({ job: sourceJobs, campaignTitle: campaigns.title })
        .from(sourceJobs)
        .innerJoin(campaigns, eq(campaigns.id, sourceJobs.campaignId))
        .where(
          and(
            status ? eq(sourceJobs.status, status as SourceJobStatus) : undefined,
            campaignId ? eq(sourceJobs.campaignId, campaignId) : undefined,
          ),
        )
        .orderBy(asc(sourceJobs.createdAt));
      return {
        jobs: rows.map(({ job, campaignTitle }) => ({
          id: job.id,
          campaignId: job.campaignId,
          campaign: campaignTitle,
          status: job.status,
          statusReason: job.statusReason,
          name: job.sourceName,
          path: job.sourcePath,
          kind: job.sourceKind,
          url: job.sourceUrl,
          opusclipProjectId: job.opusclipProjectId,
          retryCount: job.retryCount,
          updatedAt: job.updatedAt,
        })),
      };
    },
  },
  validate: {
    summary: "Check a selected video can be submitted (campaign confirmed + active, source publicly reachable) → queued.",
    usage: "<sourceJobId>",
    run: (ctx) => validateSource(submitCtx(ctx), positional(ctx, 0, "sourceJobId")),
  },
  reserve: {
    summary:
      "Reserve credits and get the exact opusclip_submit_project params (→ submitting). Pass OpusClip's monthly.remaining from opusclip_get_usage.",
    usage: "<sourceJobId> --opus-remaining <n> [--range <startSec>-<endSec>] [--estimated-minutes <m>]",
    options: { "opus-remaining": { type: "string" }, range: { type: "string" }, "estimated-minutes": { type: "string" } },
    run: (ctx) =>
      reserve(submitCtx(ctx, true), positional(ctx, 0, "sourceJobId"), {
        opusRemaining: intOption(ctx, "opus-remaining", true)!,
        range: ctx.options.range as string | undefined,
        estimatedMinutes: intOption(ctx, "estimated-minutes", false),
      }),
  },
  "record-project": {
    summary: "Record the project ID opusclip_submit_project returned (→ project_created, reservation consumed).",
    usage: "<sourceJobId> --project-id <id>",
    options: { "project-id": { type: "string" } },
    run: (ctx) => recordProject(submitCtx(ctx), positional(ctx, 0, "sourceJobId"), requiredOption(ctx, "project-id")),
  },
  "record-failure": {
    summary: "Record a failed opusclip_submit_project call: releases the reservation; transient errors re-queue (max 3).",
    usage: '<sourceJobId> --error "<connector error text>"',
    options: { error: { type: "string" } },
    run: (ctx) => recordFailure(submitCtx(ctx), positional(ctx, 0, "sourceJobId"), requiredOption(ctx, "error")),
  },
};

const showCredits: Command = {
  summary: "(read-only) Credits used/left today, per campaign, and OpusClip's last reconciled monthly usage.",
  usage: "",
  run: (ctx) => creditsSummary(ctx.db(), loadConfig(["credits"], ctx.env).OPUSCLIP_DAILY_CREDIT_BUDGET),
};

export const creditsCommands: Record<string, Command> = {
  "": showCredits,
  show: showCredits,
  reconcile: {
    summary: "Record OpusClip's usage from opusclip_get_usage (monthly.used / limit / reset_at).",
    usage: "--opus-used <n> --limit <n> --reset-at <iso>",
    options: { "opus-used": { type: "string" }, limit: { type: "string" }, "reset-at": { type: "string" } },
    run: (ctx) => {
      const resetAt = new Date(requiredOption(ctx, "reset-at"));
      if (Number.isNaN(resetAt.getTime())) throw new UsageError("--reset-at must be an ISO timestamp");
      return reconcileUsage(ctx.db(), ctx.actor, {
        used: intOption(ctx, "opus-used", true)!,
        limit: intOption(ctx, "limit", true)!,
        resetAt,
      });
    },
  },
};
