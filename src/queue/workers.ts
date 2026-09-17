import type PgBoss from "pg-boss";
import { findCampaignById } from "../db/repositories/campaigns.js";
import { findSourceJobById } from "../db/repositories/sourceJobs.js";
import { findCandidateClipsByStatus, transitionCandidateClipStatus } from "../db/repositories/candidateClips.js";
import { enumerateNewFootage, UnsupportedFootageSourceError } from "../modules/footage-enumerator/index.js";
import { processSourceJob } from "../modules/project-creator/index.js";
import { pollProjectClips } from "../modules/project-monitor/index.js";
import { runAndPersistComplianceChecks } from "../modules/compliance-service/index.js";
import { exportApprovedClip } from "../modules/export/index.js";
import { notifyNeedsAttention } from "../modules/notifier/index.js";
import { QUEUES, type EnumerateFootageJob, type ExportClipJob, type PollProjectJob, type ValidateSourceJob } from "./index.js";

export function registerItemWorkers(boss: PgBoss): void {
  boss.work<EnumerateFootageJob>(QUEUES.ENUMERATE_FOOTAGE, async (jobs) => {
    for (const job of jobs) {
      const campaign = await findCampaignById(job.data.campaignId);
      if (!campaign) continue;
      try {
        await enumerateNewFootage(campaign);
      } catch (err) {
        if (err instanceof UnsupportedFootageSourceError) {
          await notifyNeedsAttention("campaign", campaign.id, err.message);
        } else {
          throw err; // let pg-boss retry — transient Drive API failure
        }
      }
    }
  });

  boss.work<ValidateSourceJob>(QUEUES.VALIDATE_SOURCE, async (jobs) => {
    for (const job of jobs) {
      const sourceJob = await findSourceJobById(job.data.sourceJobId);
      if (!sourceJob) continue;
      await processSourceJob(sourceJob);
      const updated = await findSourceJobById(sourceJob.id);
      if (updated?.status === "needs_attention" || updated?.status === "validation_failed" || updated?.status === "submit_failed") {
        await notifyNeedsAttention("source_job", sourceJob.id, updated.status_reason ?? updated.status);
      }
    }
  });

  boss.work<PollProjectJob>(QUEUES.POLL_PROJECT, async (jobs) => {
    for (const job of jobs) {
      const sourceJob = await findSourceJobById(job.data.sourceJobId);
      if (!sourceJob) continue;
      await pollProjectClips(sourceJob);

      // Run compliance checks on anything newly retrieved and move it into review.
      const generated = await findCandidateClipsByStatus("generated");
      for (const clip of generated.filter((c) => c.source_job_id === sourceJob.id)) {
        const campaign = await findCampaignById(sourceJob.campaign_id);
        if (!campaign) continue;
        await runAndPersistComplianceChecks(clip, campaign.config);
        await transitionCandidateClipStatus(clip.id, "awaiting_review", "system", "Automated checks complete");
      }
    }
  });

  boss.work<ExportClipJob>(QUEUES.EXPORT_CLIP, async (jobs) => {
    for (const job of jobs) {
      await exportApprovedClip(job.data.candidateClipId);
    }
  });
}
