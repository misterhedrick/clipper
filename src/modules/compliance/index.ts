import type { CampaignConfig } from "../campaign-config/index.js";
import type { CheckOutcome } from "../../db/schema.js";

// Objective checks and caption rules. Pure functions: callers load the clip and
// the campaign's confirmed config, and store what comes back. A check that can't
// be verified from the data we have is `manual_review_required`, never `pass`.

type AspectRatio = CampaignConfig["clipGeneration"]["aspectRatio"];

/** What the objective checks need to know about a clip. Unknown values stay undefined. */
export type ClipFacts = {
  durationMs?: number;
  /** As reported by OpusClip: a name ("portrait"), a ratio ("9:16") or pixel dimensions. */
  aspect?: string;
  width?: number;
  height?: number;
};

export type CheckResults = Record<string, CheckOutcome>;

/** Set by `candidate set-caption` once a caption passes validateCaption(). */
export const CAPTION_CHECK = "caption_compliance";

const NAMED_ASPECTS: Record<string, AspectRatio> = {
  portrait: "portrait",
  vertical: "portrait",
  "9:16": "portrait",
  landscape: "landscape",
  horizontal: "landscape",
  "16:9": "landscape",
  square: "square",
  "1:1": "square",
  four_five: "four_five",
  "4:5": "four_five",
};
const RATIOS: [AspectRatio, number][] = [
  ["portrait", 9 / 16],
  ["landscape", 16 / 9],
  ["square", 1],
  ["four_five", 4 / 5],
];

/** Maps OpusClip's aspect description (or pixel size) onto the config's vocabulary. Undefined if unrecognized. */
export function normalizeAspect(facts: Pick<ClipFacts, "aspect" | "width" | "height">): AspectRatio | undefined {
  if (facts.aspect) {
    const key = facts.aspect.trim().toLowerCase().replace(/[x/]/g, ":").replace(/[\s-]+/g, "_");
    if (NAMED_ASPECTS[key]) return NAMED_ASPECTS[key];
    const m = key.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/);
    if (m) return nearestRatio(Number(m[1]) / Number(m[2]));
  }
  if (facts.width && facts.height) return nearestRatio(facts.width / facts.height);
  return undefined;
}

function nearestRatio(r: number): AspectRatio | undefined {
  // Within 3%: encoders round dimensions (1080x1920 vs 1088x1920), but 4:5 and 1:1 must stay distinct.
  const hit = RATIOS.find(([, target]) => Math.abs(r - target) / target <= 0.03);
  return hit?.[0];
}

/**
 * Checks that can be decided from OpusClip's clip data and the confirmed config.
 * Overlay and on-screen-text requirements, and any named review check we have
 * no verifier for, are always left to the reviewer.
 */
export function runObjectiveChecks(clip: ClipFacts, config: CampaignConfig): CheckResults {
  const { clipGeneration: gen, requirements: req, review } = config;
  const results: CheckResults = {};

  if (clip.durationMs === undefined) results.duration = "manual_review_required";
  else {
    const sec = clip.durationMs / 1000;
    results.duration = sec >= gen.minDurationSeconds && sec <= gen.maxDurationSeconds ? "pass" : "fail";
  }

  const aspect = normalizeAspect(clip);
  results.aspect_ratio = aspect === undefined ? "manual_review_required" : aspect === gen.aspectRatio ? "pass" : "fail";

  if (req.requiredOverlayAssetIds.length) results.required_overlay = "manual_review_required";
  if (req.requiredOnScreenText.length) results.required_on_screen_text = "manual_review_required";
  results[CAPTION_CHECK] = "manual_review_required";

  for (const name of review.requiredChecks) {
    if (!(name in results)) results[name] = "manual_review_required";
  }
  return results;
}

// --- captions ------------------------------------------------------------------

export type CaptionIssue = {
  rule: "empty" | "required_caption_line" | "required_tag" | "disclosure" | "hashtag_limit";
  message: string;
};

export type CaptionValidation = { valid: boolean; issues: CaptionIssue[]; additionalHashtags: string[] };

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const HASHTAG = /(?:^|[^\p{L}\p{N}_&#])#([\p{L}\p{N}_]+)/gu;
const hashtagsIn = (text: string) => [...text.matchAll(HASHTAG)].map((m) => m[1]!.toLowerCase());
const loose = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * Checks a caption against the campaign's confirmed caption rules:
 * - every `requiredCaptionLines` phrase appears verbatim;
 * - every `requiredTags` handle appears as its own token (handles are case-insensitive);
 * - every `disclosureLines` entry appears on a line of its own (FTC-style "#Ad");
 * - hashtags beyond those inside required phrases and disclosures number at most `maxAdditionalHashtags`.
 * Each broken rule is its own issue, so the operator can fix exactly what's wrong.
 */
export function validateCaption(caption: string, config: CampaignConfig): CaptionValidation {
  const req = config.requirements;
  const issues: CaptionIssue[] = [];
  if (!caption.trim()) {
    return { valid: false, issues: [{ rule: "empty", message: "caption is empty" }], additionalHashtags: [] };
  }

  for (const phrase of req.requiredCaptionLines) {
    if (caption.includes(phrase)) continue;
    const nearMiss = loose(caption).includes(loose(phrase));
    issues.push({
      rule: "required_caption_line",
      message: nearMiss
        ? `required phrase is there but not verbatim (case or punctuation differs); use exactly: "${phrase}"`
        : `missing required phrase: "${phrase}"`,
    });
  }

  for (const tag of req.requiredTags) {
    const re = new RegExp(`(?:^|[^\\p{L}\\p{N}_@])${escapeRegex(tag)}(?![\\p{L}\\p{N}_])`, "iu");
    if (!re.test(caption)) issues.push({ rule: "required_tag", message: `missing required tag ${tag}` });
  }

  const lines = caption.split(/\r?\n/).map((l) => l.trim());
  for (const disclosure of req.disclosureLines) {
    if (lines.includes(disclosure)) continue;
    issues.push({
      rule: "disclosure",
      message: caption.includes(disclosure)
        ? `disclosure "${disclosure}" must be on a line of its own`
        : `missing disclosure "${disclosure}" (on its own line)`,
    });
  }

  const allowed = new Set([...req.requiredCaptionLines, ...req.disclosureLines].flatMap(hashtagsIn));
  const additionalHashtags = [...new Set(hashtagsIn(caption))].filter((h) => !allowed.has(h));
  if (additionalHashtags.length > req.maxAdditionalHashtags) {
    issues.push({
      rule: "hashtag_limit",
      message: `${additionalHashtags.length} additional hashtags (${additionalHashtags.map((h) => `#${h}`).join(" ")}); the campaign allows at most ${req.maxAdditionalHashtags}`,
    });
  }

  return { valid: issues.length === 0, issues, additionalHashtags };
}
