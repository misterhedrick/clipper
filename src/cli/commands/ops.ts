import { loadConfig } from "../../config.js";
import { listAttention, notifyAttention } from "../../modules/attention/index.js";
import { sendNotification } from "../../modules/notifier/index.js";
import { packageCandidate } from "../../modules/packaging/index.js";
import { r2Store } from "../../modules/packaging/r2.js";
import { positional, requiredOption, type Command, type CommandContext } from "../run.js";

const notifier = (ctx: CommandContext) => {
  const { NOTIFY_WEBHOOK_URL, REVIEW_URL } = loadConfig(["notify"], ctx.env);
  return { send: (message: string) => sendNotification({ webhookUrl: NOTIFY_WEBHOOK_URL, fetch: ctx.connector.fetch }, message), reviewUrl: REVIEW_URL };
};

export const packageCommands: Record<string, Command> = {
  "": {
    summary:
      "Write an approved candidate's Ready-to-Post bundle to R2 (final.mp4, caption.txt, thumbnail.jpg, clip-metadata.json) → ready_to_post. Refuses anything a reviewer didn't approve.",
    usage: "<candidateId>",
    run: (ctx) =>
      packageCandidate(
        { db: ctx.db(), actor: ctx.actor, fetch: ctx.connector.fetch, store: ctx.bundleStore ?? r2Store(loadConfig(["r2"], ctx.env)) },
        positional(ctx, 0, "candidateId"),
      ),
  },
};

export const notifyCommands: Record<string, Command> = {
  "": {
    summary: "Send a message to the person via NOTIFY_WEBHOOK_URL (e.g. the end-of-run report).",
    usage: '--message "..."',
    options: { message: { type: "string" } },
    run: (ctx) => notifier(ctx).send(requiredOption(ctx, "message")),
  },
};

export const attentionCommands: Record<string, Command> = {
  list: {
    summary: "(read-only) Jobs and campaigns that need triage or a person, plus configs waiting for confirmation, oldest first.",
    usage: "",
    run: (ctx) => listAttention(ctx.db()),
  },
  notify: {
    summary: "Send one digest of attention items not yet announced (and configs waiting over 24h). Each item is announced once per status change.",
    usage: "",
    run: (ctx) => notifyAttention({ db: ctx.db(), actor: ctx.actor, ...notifier(ctx) }),
  },
};
