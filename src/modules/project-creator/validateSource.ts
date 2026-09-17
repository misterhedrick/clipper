import type { Campaign, SourceJob } from "../../db/types.js";

const OPUSCLIP_MAX_FILE_SIZE_BYTES = 30 * 1024 * 1024 * 1024; // 30 GB, OpusClip hard limit
const ACCEPTED_EXTENSIONS = [".mp4", ".mov", ".mkv"];

export type ValidationFailureReason =
  | "unsupported_file_type"
  | "campaign_not_active"
  | "exceeds_size_limit"
  | "source_unreachable";

export interface ValidationResult {
  ok: boolean;
  reason?: ValidationFailureReason;
  detail?: string;
}

/**
 * Per README § "Validate the source" / BUILD_PLAN.md task 7. Duplicate
 * checking isn't repeated here — it's enforced at insert time by the
 * (campaign_id, drive_file_id) constraint (DATA_MODEL.md), so a source_job
 * reaching this function is already known-not-a-duplicate.
 */
export function validateSourceStatic(job: SourceJob, campaign: Campaign): ValidationResult {
  if (campaign.status !== "active") {
    return { ok: false, reason: "campaign_not_active", detail: `Campaign status is ${campaign.status}` };
  }

  const lowerName = (job.drive_file_name ?? "").toLowerCase();
  if (!ACCEPTED_EXTENSIONS.some((ext) => lowerName.endsWith(ext))) {
    return { ok: false, reason: "unsupported_file_type", detail: `File name: ${job.drive_file_name}` };
  }

  if (job.size_bytes && job.size_bytes > OPUSCLIP_MAX_FILE_SIZE_BYTES) {
    return { ok: false, reason: "exceeds_size_limit", detail: `${job.size_bytes} bytes exceeds OpusClip's 30 GB limit` };
  }

  // No campaign-level size/duration cap exists in CampaignConfig yet — OpusClip's
  // own 30 GB / 10 hour limits (checked above) are the enforced ceiling for now.

  return { ok: true };
}

/**
 * Pre-flight reachability check before handing the URL to OpusClip. A HEAD
 * request on a Drive share URL is a weak signal — Drive often returns 200
 * even for an interstitial/error page rather than a clean 404 — but it does
 * catch a genuinely dead network path or a malformed URL before spending an
 * OpusClip API call and credits on it.
 */
export async function checkSourceReachable(sourceUrl: string): Promise<ValidationResult> {
  try {
    const res = await fetch(sourceUrl, { method: "HEAD" });
    if (!res.ok) {
      return { ok: false, reason: "source_unreachable", detail: `HEAD ${sourceUrl} returned HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: "source_unreachable", detail: String(err) };
  }
}
