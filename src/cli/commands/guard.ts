import { guardSubmit, type GuardVerdict } from "../../modules/submissions/index.js";
import type { Command } from "../run.js";

// Called by .claude/hooks/guard-opusclip-submit.sh before every OpusClip submit,
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
};
