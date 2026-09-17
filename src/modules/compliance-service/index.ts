import { setCheckResults } from "../../db/repositories/candidateClips.js";
import type { CampaignConfig, CandidateClip, CheckResult } from "../../db/types.js";

/**
 * Objectively-verifiable checks only — see README § "Run automated checks".
 * Anything this service can't actually verify from the data it has defaults
 * to manual_review_required, never pass. That includes overlay/watermark
 * and on-screen-text presence: there's no visual verification implemented
 * (that would need a video/frame-analysis pipeline, out of scope for
 * Phase 1 — see docs/BUILD_PLAN.md task 10), so those campaign
 * requirements, if configured, always land as manual_review_required.
 */
export function runComplianceChecks(clip: CandidateClip, config: CampaignConfig): Record<string, CheckResult> {
  const results: Record<string, CheckResult> = {};

  results.duration_bounds = checkDurationBounds(clip, config);
  results.export_succeeded = clip.export_url ? "pass" : "manual_review_required";

  if (config.requirements.requiredOverlayAssetIds.length > 0) {
    results.required_overlay_present = "manual_review_required";
  }
  if (config.requirements.requiredOnScreenText.length > 0) {
    results.required_on_screen_text_present = "manual_review_required";
  }
  if (config.requirements.requiredCaptionLines.length > 0) {
    results.required_caption_lines_present = checkCaptionLines(clip, config);
  }

  return results;
}

function checkDurationBounds(clip: CandidateClip, config: CampaignConfig): CheckResult {
  if (clip.duration_ms == null) return "manual_review_required";
  const seconds = clip.duration_ms / 1000;
  if (seconds < config.clipGeneration.minDurationSeconds || seconds > config.clipGeneration.maxDurationSeconds) {
    return "fail";
  }
  return "pass";
}

/**
 * OpusClip's response includes richer caption-adjacent fields (`description`,
 * `text`) that Phase 1's schema doesn't persist (see DATA_MODEL.md —
 * candidate_clips only stores title/hashtags from that set). Until that's
 * widened, this check can only look at title + hashtags, which is a real
 * gap, not a design choice: required caption wording that appears only in
 * the unstored description/text fields will show as manual_review_required
 * incorrectly. Fix by adding those columns and passing them through
 * project-monitor's upsertCandidateClip before trusting this check's "fail"
 * outcome as final.
 */
function checkCaptionLines(clip: CandidateClip, config: CampaignConfig): CheckResult {
  const haystack = `${clip.title ?? ""} ${clip.hashtags ?? ""}`.toLowerCase().trim();
  if (!haystack) return "manual_review_required";
  const allPresent = config.requirements.requiredCaptionLines.every((line) => haystack.includes(line.toLowerCase()));
  return allPresent ? "pass" : "manual_review_required";
}

export async function runAndPersistComplianceChecks(clip: CandidateClip, config: CampaignConfig): Promise<Record<string, CheckResult>> {
  const results = runComplianceChecks(clip, config);
  await setCheckResults(clip.id, results);
  return results;
}
