import { eq, inArray } from "drizzle-orm";
import { campaigns } from "../../db/schema.js";
import { cancelPost, linksToSend, markNotified, pendingApprovals, SUBMIT_WINDOW_MINUTES, openPosts, planPosts, postsForClip, recordRequested, syncPosts } from "../../modules/posting/index.js";
import { positional, readJsonInput, requiredOption, type Command, type CommandContext } from "../run.js";
import { notifier, withReviewLink } from "./ops.js";

// Publishing through OpusClip. There is deliberately no command that posts or
// marks a clip posted: the operator schedules with the params `plan` issues (the
// post guard checks them), the person confirms each post in OpusClip, and the
// person marks the clip posted on the review page.

const moduleCtx = (ctx: CommandContext) => ({ db: ctx.db(), actor: ctx.actor });

const hhmm = (d: Date | null) => (d ? `${d.toISOString().slice(11, 16)} UTC` : "no time set");

/** Sends live links the person hasn't had yet, grouped by campaign with its Content Rewards page. */
async function sendLinks(ctx: CommandContext) {
  const db = ctx.db();
  const links = await linksToSend(db);
  if (!links.length) return { sent: 0 };
  const camps = await db.select().from(campaigns).where(inArray(campaigns.id, [...new Set(links.map((l) => l.campaignId))]));
  const now = Date.now();
  const due = links.map((l) => l.submitBy).filter((d): d is Date => !!d && d.getTime() > now);
  const first = due.sort((a, b) => a.getTime() - b.getTime())[0];
  const lines = [
    `🚨 Live now. Submit on Whop (your profile → Joined → the campaign) within ${SUBMIT_WINDOW_MINUTES} minutes of posting${first ? `, by ${hhmm(first)}` : ""}:`,
  ];
  for (const c of camps) {
    lines.push("", `${c.title ?? "Campaign"}:`);
    for (const l of links.filter((x) => x.campaignId === c.id)) {
      const late = l.submitBy && l.submitBy.getTime() <= now ? " (window has likely closed)" : l.submitBy ? ` (by ${hhmm(l.submitBy)})` : "";
      lines.push(`• ${l.platform} ${l.account ?? ""}${late}: ${l.url}`);
    }
  }
  lines.push("", "Then tap Mark posted on the clip's review page.");
  const n = notifier(ctx);
  await n.send(withReviewLink(lines.join("\n"), n.reviewUrl));
  await markNotified(db, links.map((l) => l.postId));
  return { sent: links.length, links };
}

/** Sends the posts waiting for the person's confirmation to Discord, as one link. */
async function sendApprovals(ctx: CommandContext) {
  const pending = await pendingApprovals(ctx.db());
  if (!pending.combinedUrl) return { sent: 0 };
  const first = pending.posts[0]!.publishAt;
  const lines = [
    `Approve ${pending.posts.length} post${pending.posts.length === 1 ? "" : "s"} in OpusClip${first ? ` before ${hhmm(first)}` : ""} (open in your phone's browser, signed in to OpusClip):`,
    pending.combinedUrl,
    "",
    ...pending.posts.map((p) => `• ${p.platform} ${p.account ?? ""}, ${hhmm(p.publishAt)}: ${p.title ?? p.postId}`),
    "",
    "A post not approved by its time won't go out.",
  ];
  const n = notifier(ctx);
  await n.send(withReviewLink(lines.join("\n"), n.reviewUrl));
  return { sent: pending.posts.length, combinedUrl: pending.combinedUrl, posts: pending.posts };
}

export const socialCommands: Record<string, Command> = {
  plan: {
    summary:
      "Plan a ready_to_post clip's posts: one per account (docs/SOCIAL_ACCOUNTS.md), each in its account's next free slot (≥3h apart, ≤4 a day), with the exact opusclip_schedule_publish params. Idempotent.",
    usage: "<candidateId>",
    run: (ctx) => planPosts(moduleCtx(ctx), positional(ctx, 0, "candidateId")),
  },
  requested: {
    summary: "Record what opusclip_schedule_publish answered for a planned post: its approval link, or the error (frees the slot).",
    usage: "<postId> (--approval-url <url> | --error <message>)",
    options: { "approval-url": { type: "string" }, error: { type: "string" } },
    run: (ctx) =>
      recordRequested(moduleCtx(ctx), positional(ctx, 0, "postId"), {
        approvalUrl: ctx.options["approval-url"] as string | undefined,
        error: ctx.options.error as string | undefined,
      }),
  },
  alert: {
    summary: "Send the person, on Discord, one link that approves every post waiting for confirmation whose time hasn't passed. Run right after `social requested`.",
    usage: "",
    run: (ctx) => sendApprovals(ctx),
  },
  cancel: {
    summary:
      "Drop a post the person never confirmed (approval link expired, or not wanted): planned/requested → cancelled, freeing its slot for a fresh `social plan`. Scheduled posts are cancelled in OpusClip.",
    usage: '<postId> --reason "..."',
    options: { reason: { type: "string" } },
    run: (ctx) => cancelPost(moduleCtx(ctx), positional(ctx, 0, "postId"), requiredOption(ctx, "reason")),
  },
  sync: {
    summary:
      "Store an opusclip_list_scheduled_posts result: confirmed posts → scheduled, live ones → posted with their link, failed → failed. Then sends any new live links to the person (skip with --no-notify).",
    usage: "--file <posts.json | -> [--no-notify]",
    options: { file: { type: "string" }, "no-notify": { type: "boolean" } },
    run: async (ctx) => {
      const result = await syncPosts(moduleCtx(ctx), await readJsonInput(ctx, requiredOption(ctx, "file")));
      const notified = ctx.options["no-notify"] ? { sent: 0 } : await sendLinks(ctx);
      return { ...result, notified };
    },
  },
  notify: {
    summary: "Send live post links the person hasn't been sent yet (with each campaign's Content Rewards page).",
    usage: "",
    run: (ctx) => sendLinks(ctx),
  },
  list: {
    summary: "(read-only) A clip's posts, or with no id every post still waiting on OpusClip or the person.",
    usage: "[candidateId]",
    run: async (ctx) => {
      const id = ctx.positionals[0];
      return id ? { id, posts: await postsForClip(ctx.db(), id) } : openPosts(ctx.db());
    },
  },
};
