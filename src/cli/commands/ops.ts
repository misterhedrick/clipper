import { loadConfig } from "../../config.js";
import { listAttention, notifyAttention } from "../../modules/attention/index.js";
import { MAX_MESSAGE_CHARS, sendNotification, truncate } from "../../modules/notifier/index.js";
import { packageCandidate } from "../../modules/packaging/index.js";
import { r2Store } from "../../modules/packaging/r2.js";
import { DEFAULT_REMOTE_URL } from "../remote.js";
import { positional, requiredOption, type Command, type CommandContext } from "../run.js";

const notifier = (ctx: CommandContext) => {
  const { NOTIFY_WEBHOOK_URL, REVIEW_URL } = loadConfig(["notify"], ctx.env);
  return {
    send: (message: string) => sendNotification({ webhookUrl: NOTIFY_WEBHOOK_URL, fetch: ctx.connector.fetch }, message),
    // Every notification links the review page, so a person can act from their phone.
    reviewUrl: REVIEW_URL ?? DEFAULT_REMOTE_URL,
  };
};

/** Appends the review link to a message, keeping the link even when the message is truncated. */
export function withReviewLink(message: string, reviewUrl: string): string {
  const body = message.trim();
  if (!body || body.includes(reviewUrl)) return body;
  const link = `\nReview: ${reviewUrl}`;
  return truncate(body, MAX_MESSAGE_CHARS - link.length) + link;
}

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
    summary: "Send a message to the person via NOTIFY_WEBHOOK_URL (e.g. the end-of-run report), with the review page link appended.",
    usage: '--message "..."',
    options: { message: { type: "string" } },
    run: (ctx) => {
      const n = notifier(ctx);
      return n.send(withReviewLink(requiredOption(ctx, "message"), n.reviewUrl));
    },
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
