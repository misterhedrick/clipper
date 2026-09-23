import {
  addCampaign,
  classifyCampaign,
  flagCampaign,
  listCampaigns,
  scoutCampaigns,
  showCampaign,
} from "../../modules/campaigns/index.js";
import { positional, requiredOption, type Command, type CommandContext } from "../run.js";

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
  classify: {
    summary: "Record the campaign type (lf | ugc | music | slideshow | unclear) and why.",
    usage: '<id> --type <type> --reason "..."',
    options: { type: { type: "string" }, reason: { type: "string" } },
    run: (ctx) =>
      classifyCampaign(moduleCtx(ctx), positional(ctx, 0, "id"), requiredOption(ctx, "type"), requiredOption(ctx, "reason")),
  },
  flag: {
    summary: "Move a campaign to needs_attention so a person looks at it.",
    usage: '<id> --reason "..."',
    options: { reason: { type: "string" } },
    run: (ctx) => flagCampaign(moduleCtx(ctx), positional(ctx, 0, "id"), requiredOption(ctx, "reason")),
  },
};
