import { addFootageSource, decideFootage, listDecisions, listFootage } from "../../modules/sourcing/index.js";
import { positional, requiredOption, type Command, type CommandContext } from "../run.js";

const sourcingCtx = (ctx: CommandContext) => ({ db: ctx.db(), actor: ctx.actor, list: { fetch: ctx.connector.fetch } });
const str = (ctx: CommandContext, name: string) => ctx.options[name] as string | undefined;

const decide = (decision: "selected" | "skipped"): Command => ({
  summary:
    decision === "selected"
      ? "Select one video for processing (creates a source job in `detected`)."
      : "Record a deliberate skip so the video isn't re-evaluated on later runs.",
  usage: '<campaignId> --url <videoUrl> --reason "..." [--name <name>] [--path <folderPath>] [--from <footageSourceUrl>]',
  options: {
    url: { type: "string" },
    reason: { type: "string" },
    name: { type: "string" },
    path: { type: "string" },
    from: { type: "string" },
  },
  run: (ctx) =>
    decideFootage(sourcingCtx(ctx), positional(ctx, 0, "campaignId"), requiredOption(ctx, "url"), decision, requiredOption(ctx, "reason"), {
      name: str(ctx, "name"),
      path: str(ctx, "path"),
      from: str(ctx, "from"),
    }),
});

export const footageCommands: Record<string, Command> = {
  "list-url": {
    summary:
      "(read-only) Expand a Drive folder (recursive), YouTube channel (recent uploads) or file link into entries. With --campaign, marks what's already decided.",
    usage: "<url> [--campaign <id>]",
    options: { campaign: { type: "string" } },
    run: (ctx) => listFootage(sourcingCtx(ctx), positional(ctx, 0, "url"), str(ctx, "campaign")),
  },
  add: {
    summary: "Register a footage location (folder, channel or file) for a campaign. Idempotent per URL.",
    usage: '<campaignId> --url <url> --reason "..." [--label "..."]',
    options: { url: { type: "string" }, reason: { type: "string" }, label: { type: "string" } },
    run: (ctx) =>
      addFootageSource(sourcingCtx(ctx), positional(ctx, 0, "campaignId"), requiredOption(ctx, "url"), str(ctx, "label"), requiredOption(ctx, "reason")),
  },
  select: decide("selected"),
  skip: decide("skipped"),
  list: {
    summary: "(read-only) A campaign's registered footage sources and every select/skip decision with its reason.",
    usage: "<campaignId> [--decision selected|skipped]",
    options: { decision: { type: "string" } },
    run: (ctx) => listDecisions(ctx.db(), positional(ctx, 0, "campaignId"), str(ctx, "decision")),
  },
};
