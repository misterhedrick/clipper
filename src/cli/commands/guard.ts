import { guardEdit, type EditGuardVerdict } from "../../modules/candidates/index.js";
import { guardSubmit, type GuardVerdict } from "../../modules/submissions/index.js";
import { guardPost, type PostGuardVerdict } from "../../modules/posting/index.js";
import type { Command } from "../run.js";

// Called by .claude/hooks/guard-opusclip-*.sh before every OpusClip submit, clip edit or post,
// with the PreToolUse payload on stdin. Exit 0 allows the call; exit 2 blocks it
// and shows the reason to Claude. Any error also ends in a block (the hook maps
// every non-zero exit to 2).

export const guardCommands: Record<string, Command> = {
  submit: {
    summary: "Hook: allow an OpusClip submission only if it exactly matches an open credit reservation.",
    usage: "(reads the PreToolUse payload on stdin)",
    run: async (ctx) => guardSubmit(ctx.db(), await ctx.stdin()),
    exitCode: (result) => ((result as GuardVerdict).allow ? 0 : 2),
  },
  edit: {
    summary:
      "Hook: allow an OpusClip clip edit only as a dry run, for a reviewer's needs_edit, or as an automatic fix of a failed check (fixing ops only, at most 2 per clip).",
    usage: "(reads the PreToolUse payload on stdin)",
    run: async (ctx) => guardEdit(ctx.db(), await ctx.stdin()),
    exitCode: (result) => ((result as EditGuardVerdict).allow ? 0 : 2),
  },
  post: {
    summary: "Hook: allow opusclip_schedule_publish only with the exact params of a planned post (`clipper social plan`) for a ready_to_post clip. Immediate posts are never allowed.",
    usage: "(reads the PreToolUse payload on stdin)",
    run: async (ctx) => guardPost(ctx.db(), await ctx.stdin()),
    exitCode: (result) => ((result as PostGuardVerdict).allow ? 0 : 2),
  },
};
