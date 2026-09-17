import { config } from "../../config.js";
import { findCampaignById } from "../../db/repositories/campaigns.js";
import { incrementRetryCount, setOpusClipProjectId, transitionSourceJobStatus } from "../../db/repositories/sourceJobs.js";
import type { SourceJob } from "../../db/types.js";
import { createClipProject, OpusClipError } from "../../lib/opusclip.js";
import { checkSourceReachable, validateSourceStatic } from "./validateSource.js";

const MAX_RETRIES = 5;

export class PermanentSourceJobFailure extends Error {}

/**
 * Runs validation, the pre-flight reachability check, and (if both pass)
 * submits the source to OpusClip — see BUILD_PLAN.md tasks 7-8. No file
 * transfer happens here; this is a thin API call plus bookkeeping, per
 * ARCHITECTURE.md § project-creator.
 */
export async function processSourceJob(job: SourceJob): Promise<void> {
  const campaign = await findCampaignById(job.campaign_id);
  if (!campaign) {
    throw new PermanentSourceJobFailure(`source_job ${job.id} references missing campaign ${job.campaign_id}`);
  }

  await transitionSourceJobStatus(job.id, "validating", "system");

  const staticResult = validateSourceStatic(job, campaign);
  if (!staticResult.ok) {
    await transitionSourceJobStatus(job.id, "validation_failed", "system", `${staticResult.reason}: ${staticResult.detail}`);
    return;
  }

  const reachability = await checkSourceReachable(job.source_url);
  if (!reachability.ok) {
    // Treated as retryable — a transient Drive quota rejection looks identical
    // to a genuinely dead link from a HEAD request alone. See README § Retry policy.
    await handleRetryableFailure(job, `source_unreachable: ${reachability.detail}`);
    return;
  }

  await transitionSourceJobStatus(job.id, "submitting", "system");

  try {
    const result = await createClipProject({
      videoUrl: job.source_url,
      campaignConfig: campaign.config,
      webhookUrl: `${config.PUBLIC_BASE_URL}/webhooks/opusclip`,
      sourceJobId: job.id,
    });
    await setOpusClipProjectId(job.id, result.projectId);
    await transitionSourceJobStatus(job.id, "project_created", "system", `OpusClip project ${result.projectId} created`);
  } catch (err) {
    if (err instanceof OpusClipError && !err.retryable) {
      await transitionSourceJobStatus(job.id, "submit_failed", "system", err.message, {
        status: err.status,
        body: err.body,
      });
      return;
    }
    await handleRetryableFailure(job, err instanceof Error ? err.message : String(err));
  }
}

async function handleRetryableFailure(job: SourceJob, reason: string): Promise<void> {
  const updated = await incrementRetryCount(job.id);
  if (updated.retry_count >= MAX_RETRIES) {
    await transitionSourceJobStatus(job.id, "needs_attention", "system", `Exhausted ${MAX_RETRIES} retries: ${reason}`);
    return;
  }
  // Re-queue is handled by the caller (queue worker) via exponential backoff —
  // this just records the attempt and reason. Status stays as-is (queued/submitting)
  // so the next queue attempt picks it back up.
  await transitionSourceJobStatus(job.id, "queued", "system", `Retry ${updated.retry_count}/${MAX_RETRIES}: ${reason}`);
}
