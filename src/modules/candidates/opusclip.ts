import { z } from "zod";

// Reads what `opusclip_list_clips` returned, as the operator saved it to a file.
//
// The connector's tool description promises rank, score, sub-scores, title,
// description, hashtags, duration, preview/thumbnail URLs and the project
// `stage`, but no project had been created when this was written, so the exact
// key names weren't observed. The reader accepts the plausible spellings
// (snake_case, camelCase, and the REST API's `uriForPreview` style), and fails
// loudly on anything without a clip ID, so a surprise shows up as an error on
// the first live run rather than as silently empty candidates.

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
  aspect?: string;
  width?: number;
  height?: number;
};

export type OpusClipList = { stage?: string; projectId?: string; clips: OpusClip[] };

const num = z.union([z.number(), z.string().trim().regex(/^-?\d+(\.\d+)?$/).transform(Number)]);
const str = z.string();
const id = z.union([z.string().trim().min(1), z.number().transform(String)]);

const clipSchema = z.looseObject({
  id: id.optional(),
  clip_id: id.optional(),
  clipId: id.optional(),
  project_id: id.optional(),
  projectId: id.optional(),
  rank: num.optional(),
  title: str.nullish(),
  description: str.nullish(),
  hashtags: z.union([str, z.array(str)]).nullish(),
  duration_ms: num.optional(),
  durationMs: num.optional(),
  duration_sec: num.optional(),
  duration_seconds: num.optional(),
  durationSec: num.optional(),
  duration: num.optional(),
  score: num.nullish(),
  sub_scores: z.record(z.string(), num).nullish(),
  subScores: z.record(z.string(), num).nullish(),
  judge_scores: z.record(z.string(), num).nullish(),
  hook: num.optional(),
  coherence: num.optional(),
  connection: num.optional(),
  trend: num.optional(),
  preview_url: str.nullish(),
  previewUrl: str.nullish(),
  uriForPreview: str.nullish(),
  thumbnail_url: str.nullish(),
  thumbnailUrl: str.nullish(),
  uriForThumbnail: str.nullish(),
  aspect_ratio: str.nullish(),
  aspectRatio: str.nullish(),
  layout: z.unknown().optional(),
  width: num.optional(),
  height: num.optional(),
});

const listSchema = z.looseObject({
  clips: z.array(z.unknown()).optional(),
  data: z.array(z.unknown()).optional(),
  items: z.array(z.unknown()).optional(),
  stage: str.nullish(),
  project_stage: str.nullish(),
  projectStage: str.nullish(),
  project_id: id.optional(),
  projectId: id.optional(),
});

export class OpusClipParseError extends Error {
  readonly code = "invalid_argument";
  constructor(message: string) {
    super(message);
    this.name = "OpusClipParseError";
  }
}

const SUB_SCORES = ["hook", "coherence", "connection", "trend"] as const;

/**
 * Duration in ms. `duration` alone is ambiguous: OpusClip clips are at most 600 s,
 * so a bare value over 600 can only be milliseconds.
 */
function durationMs(c: z.infer<typeof clipSchema>): number | undefined {
  if (c.duration_ms !== undefined) return Math.round(c.duration_ms);
  if (c.durationMs !== undefined) return Math.round(c.durationMs);
  const sec = c.duration_sec ?? c.duration_seconds ?? c.durationSec;
  if (sec !== undefined) return Math.round(sec * 1000);
  if (c.duration !== undefined) return Math.round(c.duration > 600 ? c.duration : c.duration * 1000);
  return undefined;
}

function toClip(raw: unknown, index: number): OpusClip {
  const parsed = clipSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    throw new OpusClipParseError(`clip ${index}: ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  const c = parsed.data;
  const clipId = c.clip_id ?? c.clipId ?? c.id;
  if (!clipId) throw new OpusClipParseError(`clip ${index} has no id (expected id, clip_id or clipId)`);

  let subScores = c.sub_scores ?? c.subScores ?? c.judge_scores ?? undefined;
  if (!subScores) {
    const flat = Object.fromEntries(SUB_SCORES.filter((k) => c[k] !== undefined).map((k) => [k, c[k] as number]));
    if (Object.keys(flat).length) subScores = flat;
  }
  const layoutAspect = typeof c.layout === "string" ? c.layout : undefined;
  const opt = <T>(v: T | null | undefined) => (v === null || v === undefined ? undefined : v);

  return {
    clipId,
    projectId: c.project_id ?? c.projectId,
    rank: c.rank,
    title: opt(c.title),
    description: opt(c.description),
    hashtags: Array.isArray(c.hashtags) ? c.hashtags.join(" ") : opt(c.hashtags),
    durationMs: durationMs(c),
    score: opt(c.score),
    subScores,
    previewUrl: opt(c.preview_url ?? c.previewUrl ?? c.uriForPreview),
    thumbnailUrl: opt(c.thumbnail_url ?? c.thumbnailUrl ?? c.uriForThumbnail),
    aspect: opt(c.aspect_ratio ?? c.aspectRatio) ?? layoutAspect,
    width: c.width,
    height: c.height,
  };
}

/**
 * Accepts the tool's JSON result: `{ clips, stage, … }`, a bare array of clips,
 * or the MCP envelope `{ content: [{ type: "text", text: "<json>" }] }`.
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
  if (Array.isArray(input)) return { clips: input.map(toClip) };

  const parsed = listSchema.safeParse(input);
  if (!parsed.success) throw new OpusClipParseError("expected the opusclip_list_clips result: an object with a clips array, or an array");
  const l = parsed.data;
  const rawClips = l.clips ?? l.data ?? l.items;
  if (!rawClips) throw new OpusClipParseError("no clips array in the result (expected clips, data or items)");
  return {
    stage: l.stage ?? l.project_stage ?? l.projectStage ?? undefined,
    projectId: l.project_id ?? l.projectId,
    clips: rawClips.map(toClip),
  };
}

// Project stages: the vocabulary wasn't observed yet, so classify by keyword.
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
