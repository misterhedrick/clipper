import { findCandidateClipById, transitionCandidateClipStatus } from "../../db/repositories/candidateClips.js";
import { findSourceJobById } from "../../db/repositories/sourceJobs.js";
import { findCampaignById } from "../../db/repositories/campaigns.js";
import { createPostRecord } from "../../db/repositories/posts.js";
import { putSmallObject, streamUrlToR2 } from "../../lib/r2.js";

export class ExportNotReadyError extends Error {}

/**
 * Builds the Ready to Post package per README § "Prepare approved clips":
 * final.mp4, caption.txt, clip-metadata.json, thumbnail.jpg — uploaded to
 * Cloudflare R2 (see docs/DEPLOYMENT.md), plus a posts row per platform.
 *
 * Known gap: OpusClip's documented get-clips response (docs/API_CONTRACTS.md)
 * has no dedicated thumbnail field — only uriForPreview/uriForExport. A real
 * thumbnail.jpg would need frame extraction from the exported video, which
 * is out of scope for Phase 1. This function skips it rather than uploading
 * something fake; BUILD_PLAN.md task 12 should be revisited once a thumbnail
 * source is confirmed (OpusClip may expose one under a field name not seen
 * in the docs consulted, or this needs local video processing).
 */
export async function exportApprovedClip(candidateClipId: string): Promise<void> {
  const clip = await findCandidateClipById(candidateClipId);
  if (!clip) throw new Error(`candidate_clip ${candidateClipId} not found`);
  if (clip.status !== "approved") {
    throw new Error(`candidate_clip ${candidateClipId} is not approved (status: ${clip.status})`);
  }
  if (!clip.export_url) {
    // OpusClip may not have finished the HD export yet — let the queue retry.
    throw new ExportNotReadyError(`candidate_clip ${candidateClipId} has no export_url yet`);
  }

  const sourceJob = await findSourceJobById(clip.source_job_id);
  if (!sourceJob) throw new Error(`source_job ${clip.source_job_id} not found`);
  const campaign = await findCampaignById(sourceJob.campaign_id);
  if (!campaign) throw new Error(`campaign ${sourceJob.campaign_id} not found`);

  await transitionCandidateClipStatus(clip.id, "exporting", "system");

  const prefix = `${campaign.id}/${clip.id}/`;

  await streamUrlToR2(clip.export_url, `${prefix}final.mp4`, "video/mp4");

  const captionLines = [
    ...campaign.config.requirements.requiredCaptionLines,
    ...campaign.config.requirements.disclosureLines,
    clip.hashtags ?? "",
  ].filter(Boolean);
  await putSmallObject(`${prefix}caption.txt`, captionLines.join("\n"), "text/plain");

  const metadata = {
    candidateClipId: clip.id,
    campaignId: campaign.id,
    campaignTitle: campaign.title,
    sourceJobId: sourceJob.id,
    opusclipClipId: clip.opusclip_clip_id,
    title: clip.title,
    durationMs: clip.duration_ms,
    checkResults: clip.check_results,
    exportedAt: new Date().toISOString(),
  };
  await putSmallObject(`${prefix}clip-metadata.json`, JSON.stringify(metadata, null, 2), "application/json");

  for (const platform of campaign.platforms) {
    if (platform === "tiktok" || platform === "instagram" || platform === "youtube") {
      await createPostRecord({ candidateClipId: clip.id, platform });
    }
  }

  await transitionCandidateClipStatus(clip.id, "ready_to_post", "system", `Exported to R2 at ${prefix}`);
}
