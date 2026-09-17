import type PgBoss from "pg-boss";
import { listActiveCampaigns } from "../db/repositories/campaigns.js";
import { findSourceJobsByStatus } from "../db/repositories/sourceJobs.js";
import { QUEUES } from "./index.js";

/**
 * Recurring scan jobs — these are what turn "a file appeared in Drive" or
 * "OpusClip finished processing" into actual queue sends, since pg-boss's
 * own schedule() only supports static per-schedule data, not "one send per
 * campaign/job currently in a given state." Each scan just fans out
 * individual sends; the real work happens in the per-item workers.
 */

const SCAN_ACTIVE_CAMPAIGNS = "scan-active-campaigns";
const SCAN_PENDING_SOURCE_JOBS = "scan-pending-source-jobs";
const SCAN_PROCESSING_PROJECTS = "scan-processing-projects";

export async function registerScanSchedules(boss: PgBoss): Promise<void> {
  await boss.createQueue(SCAN_ACTIVE_CAMPAIGNS);
  await boss.createQueue(SCAN_PENDING_SOURCE_JOBS);
  await boss.createQueue(SCAN_PROCESSING_PROJECTS);

  // Footage folders don't change often — every 10 minutes is plenty.
  await boss.schedule(SCAN_ACTIVE_CAMPAIGNS, "*/10 * * * *");
  // Validation/submission should move quickly once a file is detected.
  await boss.schedule(SCAN_PENDING_SOURCE_JOBS, "*/2 * * * *");
  // Backoff schedule per README § Retry policy would ideally vary per-job age;
  // a flat 30s poll is the Phase 1 baseline — see BUILD_PLAN.md task 9.
  await boss.schedule(SCAN_PROCESSING_PROJECTS, "*/1 * * * *");

  await boss.work(SCAN_ACTIVE_CAMPAIGNS, async () => {
    const campaigns = await listActiveCampaigns();
    for (const campaign of campaigns) {
      await boss.send(QUEUES.ENUMERATE_FOOTAGE, { campaignId: campaign.id });
    }
  });

  await boss.work(SCAN_PENDING_SOURCE_JOBS, async () => {
    const detected = await findSourceJobsByStatus("detected");
    const queued = await findSourceJobsByStatus("queued");
    for (const job of [...detected, ...queued]) {
      await boss.send(QUEUES.VALIDATE_SOURCE, { sourceJobId: job.id });
    }
  });

  await boss.work(SCAN_PROCESSING_PROJECTS, async () => {
    const created = await findSourceJobsByStatus("project_created");
    const processing = await findSourceJobsByStatus("processing");
    for (const job of [...created, ...processing]) {
      await boss.send(QUEUES.POLL_PROJECT, { sourceJobId: job.id });
    }
  });
}
