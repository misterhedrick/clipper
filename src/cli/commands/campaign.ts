import {
  activateVerifiedCampaign,
  addCampaign,
  classifyCampaign,
  flagCampaign,
  listCampaigns,
  proposeConfig,
  readCampaignBrief,
  resolveCampaign,
  scoutCampaigns,
  showCampaign,
  verifyConfig,
} from "../../modules/campaigns/index.js";
import { deleteCampaign } from "../../modules/review/index.js";
import { positional, readJsonInput, requiredOption, type Command, type CommandContext } from "../run.js";

const moduleCtx = (ctx: CommandContext) => ({ db: ctx.db(), actor: ctx.actor, connector: ctx.connector });

export const campaignCommands: Record<string, Command> = {
  scout: {
    summary: "List campaigns on the Content Rewards discover page that aren't tracked yet (--all to include tracked).",
    usage: "[--all]",
    options: { all: { type: "boolean" } },
    run: (ctx) => scoutCampaigns(moduleCtx(ctx), { all: ctx.options.all === true }),
  },
  add: {
    summary: "Track a campaign (status: discovered). Idempotent: re-adding returns the existing one.",
    usage: "<contentRewardsUrl>",
    run: (ctx) => addCampaign(moduleCtx(ctx), positional(ctx, 0, "contentRewardsUrl")),
  },
  show: {
    summary: "A campaign with its config, Content Rewards snapshot, footage sources, and job/clip counts.",
    usage: "<id | contentRewardsCampaignId | url>",
    run: (ctx) => showCampaign(ctx.db(), positional(ctx, 0, "id")),
  },
  list: {
    summary: "Tracked campaigns, newest first.",
    usage: "[--status <status>]",
    options: { status: { type: "string" } },
    run: (ctx) => listCampaigns(ctx.db(), { status: ctx.options.status as string | undefined }),
  },
  brief: {
    summary: "The brief as text (links shown inline as `text <url>`) + every link + reference materials. --doc reads a linked sub-doc.",
    usage: "<id> [--doc <googleDocUrl>]",
    options: { doc: { type: "string" } },
    run: (ctx) =>
      readCampaignBrief(
        { ...moduleCtx(ctx), reader: { fetch: ctx.connector.fetch } },
        positional(ctx, 0, "id"),
        ctx.options.doc as string | undefined,
      ),
  },
  classify: {
    summary: "Record the campaign type (lf | ugc | music | slideshow | unclear) and why.",
    usage: '<id> --type <type> --reason "..."',
    options: { type: { type: "string" }, reason: { type: "string" } },
    run: (ctx) =>
      classifyCampaign(moduleCtx(ctx), positional(ctx, 0, "id"), requiredOption(ctx, "type"), requiredOption(ctx, "reason")),
  },
  "propose-config": {
    summary:
      "Validate a drafted (or corrected) config and park it for verification (→ pending_confirmation). --dry-run only validates. Never activates.",
    usage: "<id> --file <config.json | -> [--dry-run]",
    options: { file: { type: "string" }, "dry-run": { type: "boolean" } },
    run: async (ctx) =>
      proposeConfig(moduleCtx(ctx), positional(ctx, 0, "id"), await readJsonInput(ctx, requiredOption(ctx, "file")), {
        dryRun: ctx.options["dry-run"] === true,
      }),
  },
  "verify-config": {
    summary:
      "Record one round of checking the proposed config against the campaign page and brief: every config field match | mismatch | unsettled with evidence, plus missed rules. Unsettled, or still mismatched after 3 rounds, flags the campaign for a person.",
    usage: "<id> --file <verification.json | ->   ({sources, summary, fields: {<field>: {result, evidence}}, missedRules})",
    options: { file: { type: "string" } },
    run: async (ctx) => verifyConfig(moduleCtx(ctx), positional(ctx, 0, "id"), await readJsonInput(ctx, requiredOption(ctx, "file"))),
  },
  activate: {
    summary:
      "Standing rule: activate a campaign whose current config your latest verify-config round found fully matching. Returns the Content Rewards link the person must join.",
    usage: "<id>",
    run: (ctx) => activateVerifiedCampaign(moduleCtx(ctx), positional(ctx, 0, "id")),
  },
  flag: {
    summary: "Move a campaign to needs_attention so a person looks at it.",
    usage: '<id> --reason "..."',
    options: { reason: { type: "string" } },
    run: (ctx) => flagCampaign(moduleCtx(ctx), positional(ctx, 0, "id"), requiredOption(ctx, "reason")),
  },
  delete: {
    summary:
      "Delete a campaign a person asked to have removed, with its sources, jobs and clips (it can be re-added later). Refused once any clip was posted. Only when a person asks; never on your own judgment.",
    usage: '<id> --reason "..." --requested-by <name>',
    options: { reason: { type: "string" }, "requested-by": { type: "string" } },
    run: async (ctx) => {
      const { id } = await resolveCampaign(ctx.db(), positional(ctx, 0, "id"));
      return deleteCampaign({ db: ctx.db(), actor: ctx.actor }, id, undefined, {
        reason: requiredOption(ctx, "reason"),
        requestedBy: requiredOption(ctx, "requested-by"),
      });
    },
  },
};
