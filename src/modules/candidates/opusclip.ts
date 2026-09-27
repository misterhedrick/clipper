import { z } from "zod";

// Reads what `opusclip_list_clips` returned, as the operator saved it to a file.
//
// The shape was observed live (projects P3092415v0K3 on 2026-09-24 and
// P30927016SMZ on 2026-09-27): `{ clips, total, stage }`, each clip with
// `project_id`, `clip_id`, `rank`, `score`, `title`, `description`, `hashtags`
// (an array), `duration_sec`, `is_bonus`, `preview_url`, `thumbnail_url` and the
// judge sub-scores as `hook_score`, `coherence_score`, `connection_score` and
// `trend_score`. `is_bonus` isn't kept: the `_bonus` copy of the top clip comes
// in as its own candidate and pre-screen holds it as a duplicate. OpusClip reports no aspect ratio or dimensions, so the aspect
// check is left to the reviewer. Unknown keys are ignored; anything without a
// clip ID fails loudly, so a change in the tool's output shows up as an error
// rather than as silently empty candidates.

export type OpusClip = {
  clipId: string;
  projectId?: string;
  rank?: number;
  title?: string;
  description?: string;
  hashtags?: string;
  durationMs?: number;
  score?: number;
  subScores?: Record<string, number>;
  previewUrl?: string;
  thumbnailUrl?: string;
};

export type OpusClipList = { stage?: string; clips: OpusClip[] };

const num = z.number();
const str = z.string();

const clipSchema = z.looseObject({
  clip_id: str.trim().min(1),
  project_id: str.optional(),
  rank: num.nullish(),
  score: num.nullish(),
  title: str.nullish(),
  description: str.nullish(),
  hashtags: z.array(str).nullish(),
  duration_sec: num.nullish(),
  preview_url: str.nullish(),
  thumbnail_url: str.nullish(),
  hook_score: num.nullish(),
  coherence_score: num.nullish(),
  connection_score: num.nullish(),
  trend_score: num.nullish(),
});

const listSchema = z.looseObject({
  clips: z.array(z.unknown()),
  stage: str.nullish(),
});

export class OpusClipParseError extends Error {
  readonly code = "invalid_argument";
  constructor(message: string) {
    super(message);
    this.name = "OpusClipParseError";
  }
}

const SUB_SCORES = ["hook", "coherence", "connection", "trend"] as const;

function toClip(raw: unknown, index: number): OpusClip {
  const parsed = clipSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new OpusClipParseError(`clip ${index}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const c = parsed.data;
  const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);

  const subScores: Record<string, number> = {};
  for (const k of SUB_SCORES) {
    const v = c[`${k}_score`];
    if (typeof v === "number") subScores[k] = v;
  }

  return {
    clipId: c.clip_id,
    projectId: c.project_id,
    rank: opt(c.rank),
    title: opt(c.title),
    description: opt(c.description),
    hashtags: c.hashtags?.length ? c.hashtags.join(" ") : undefined,
    durationMs: typeof c.duration_sec === "number" ? Math.round(c.duration_sec * 1000) : undefined,
    score: opt(c.score),
    subScores: Object.keys(subScores).length ? subScores : undefined,
    previewUrl: opt(c.preview_url),
    thumbnailUrl: opt(c.thumbnail_url),
  };
}

/**
 * Accepts the tool's JSON result `{ clips, stage, … }`, or the MCP envelope
 * `{ content: [{ type: "text", text: "<json>" }] }` around it.
 */
export function parseOpusClipList(input: unknown): OpusClipList {
  const envelope = input as { content?: { type?: string; text?: unknown }[] } | null;
  if (envelope && typeof envelope === "object" && Array.isArray(envelope.content)) {
    const text = envelope.content.find((p) => p?.type === "text" && typeof p.text === "string")?.text as string | undefined;
    if (!text) throw new OpusClipParseError("MCP result has no text content");
    try {
      return parseOpusClipList(JSON.parse(text));
    } catch (err) {
      if (err instanceof OpusClipParseError) throw err;
      throw new OpusClipParseError(`MCP result text isn't JSON: ${(err as Error).message}`);
    }
  }
  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new OpusClipParseError("expected the opusclip_list_clips result: an object with a clips array");
  return { stage: parsed.data.stage ?? undefined, clips: parsed.data.clips.map(toClip) };
}

// Project stages: only COMPLETE has been observed, so classify by keyword.
// Anything unrecognized counts as in progress: the job keeps being collected
// (its clips are already reviewable), and a project with no clips after
// MAX_PROCESSING_HOURS goes to needs_attention. No stage at all but clips
// present counts as done.
const FAILED_STAGE = /fail|error|cancel|abort|reject/i;
const DONE_STAGE = /complete|done|finish|success|succeed|ready|clipped|published/i;

export type StageKind = "failed" | "done" | "in_progress";

export function classifyStage(stage: string | undefined, clipCount: number): StageKind {
  if (stage && FAILED_STAGE.test(stage)) return "failed";
  if (stage && DONE_STAGE.test(stage)) return "done";
  if (!stage && clipCount > 0) return "done";
  return "in_progress";
}
