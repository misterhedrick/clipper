import type { Command } from "../run.js";

// Called by .claude/hooks/guard-opusclip-submit.sh before every OpusClip submit.
// Exit 2 blocks the connector call. The real check (match against an open credit
// reservation) is BUILD_PLAN task 8; until then every submission is blocked.

export const guardCommands: Record<string, Command> = {
  submit: {
    summary: "Hook: allow an OpusClip submission only if it matches an open credit reservation.",
    usage: "(reads the PreToolUse payload on stdin)",
    run: async () => ({
      allow: false,
      reason:
        "Blocked: the reservation check (BUILD_PLAN task 8) isn't built yet, so no OpusClip submissions are allowed.",
    }),
    exitCode: (result) => ((result as { allow: boolean }).allow ? 0 : 2),
  },
};
