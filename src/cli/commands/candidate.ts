import {
  listCandidates,
  prescreenCandidate,
  recordEdit,
  rejectCandidates,
  setCaption,
  upsertCandidates,
} from "../../modules/candidates/index.js";
import { resolveCampaign } from "../../modules/campaigns/index.js";
import { recordExport } from "../../modules/packaging/index.js";
import { positional, readJsonInput, readTextInput, requiredOption, type Command, type CommandContext } from "../run.js";

// There is deliberately no approve / needs-edit / post command here: those are
// a reviewer's decisions, made in the review web app. `reject` is the one
// exception, and only for a person who asked for it by name (--requested-by).

const moduleCtx = (ctx: CommandContext) => ({ db: ctx.db(), actor: ctx.actor });

export const candidateCommands: Record<string, Command> = {
  upsert: {
    summary:
      "Store an opusclip_list_clips result for a job: dedupe by clip ID, run objective checks, new candidates → awaiting_review; job → processing / candidates_ready / needs_attention by stage.",
    usage: "<sourceJobId> --file <clips.json | ->",
    options: { file: { type: "string" } },
    run: async (ctx) =>
      upsertCandidates(moduleCtx(ctx), positional(ctx, 0, "sourceJobId"), await readJsonInput(ctx, requiredOption(ctx, "file"))),
  },
  list: {
    summary: "(read-only) Candidates, oldest first, with OpusClip metadata, check results, pre-screen and caption.",
    usage: "[--status <status>] [--campaign <id>] [--job <sourceJobId>]",
    options: { status: { type: "string" }, campaign: { type: "string" }, job: { type: "string" } },
    run: async (ctx) => {
      const db = ctx.db();
      const campaignId = ctx.options.campaign ? (await resolveCampaign(db, ctx.options.campaign as string)).id : undefined;
      return listCandidates(db, { status: ctx.options.status as string | undefined, campaignId, jobId: ctx.options.job as string | undefined });
    },
  },
  prescreen: {
    summary: "Record an advisory verdict (recommend | hold | reject) with notes. Never approves; changes no status.",
    usage: '<candidateId> --verdict <recommend|hold|reject> --notes "..."',
    options: { verdict: { type: "string" }, notes: { type: "string" } },
    run: (ctx) =>
      prescreenCandidate(moduleCtx(ctx), positional(ctx, 0, "candidateId"), requiredOption(ctx, "verdict"), requiredOption(ctx, "notes")),
  },
  reject: {
    summary:
      "Reject clips a person asked to have rejected: the listed ones, or every clip of --campaign still awaiting_review / needs_edit. Only when a person asks; never on your own judgment.",
    usage: '<candidateId...> | --campaign <id> --reason "..." --requested-by <name>',
    options: { campaign: { type: "string" }, reason: { type: "string" }, "requested-by": { type: "string" } },
    run: async (ctx) => {
      const campaignId = ctx.options.campaign ? (await resolveCampaign(ctx.db(), ctx.options.campaign as string)).id : undefined;
      return rejectCandidates(
        moduleCtx(ctx),
        { ids: ctx.positionals, campaignId },
        requiredOption(ctx, "reason"),
        requiredOption(ctx, "requested-by"),
      );
    },
  },
  "set-caption": {
    summary: "Store a caption draft, only if it has every required phrase, tag and disclosure and stays within the hashtag limit.",
    usage: "<candidateId> --file <caption.txt | ->",
    options: { file: { type: "string" } },
    run: async (ctx) => setCaption(moduleCtx(ctx), positional(ctx, 0, "candidateId"), await readTextInput(ctx, requiredOption(ctx, "file"))),
  },
  "record-export": {
    summary: "Store the HD export_url from opusclip_export_clip for an approved candidate (then run `clipper package`).",
    usage: "<candidateId> --url <exportUrl>",
    options: { url: { type: "string" } },
    run: (ctx) => recordExport(moduleCtx(ctx), positional(ctx, 0, "candidateId"), requiredOption(ctx, "url")),
  },
  "record-edit": {
    summary: "Log an opusclip_edit_clip call made for a reviewer's needs_edit request; the candidate returns to awaiting_review.",
    usage: '<candidateId> --ops-file <ops.json | -> --reason "<reviewer note → what you changed>"',
    options: { "ops-file": { type: "string" }, reason: { type: "string" } },
    run: async (ctx) =>
      recordEdit(
        moduleCtx(ctx),
        positional(ctx, 0, "candidateId"),
        await readJsonInput(ctx, requiredOption(ctx, "ops-file")),
        requiredOption(ctx, "reason"),
      ),
  },
};
