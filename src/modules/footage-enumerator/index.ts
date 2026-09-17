import { driveFileShareUrl, isAcceptedVideoFile, listDriveFolderFiles } from "./driveApi.js";
import { createSourceJob, listDriveFileIdsForCampaign } from "../../db/repositories/sourceJobs.js";
import type { Campaign } from "../../db/types.js";

export interface EnumerationResult {
  newJobsCreated: number;
  filesSeen: number;
  skippedNonVideo: number;
}

export class UnsupportedFootageSourceError extends Error {}

/**
 * Lists files in the campaign's Google Drive folder and creates one
 * source_job per file not already known for this campaign. Idempotent by
 * design — the (campaign_id, drive_file_id) unique constraint is the real
 * guarantee (see DATA_MODEL.md); the pre-check here just avoids noisy
 * conflict handling in the common case.
 *
 * Only handles campaigns whose footage source resolved to Google Drive —
 * per docs/API_CONTRACTS.md, some campaigns (e.g. MW4 Clipping, observed
 * during implementation) put their footage on MediaSilo or elsewhere
 * instead. Callers must not invoke this for a campaign whose
 * drive_folder_id is unset; that's a distinct, explicit failure mode (see
 * BUILD_PLAN.md task 6), not something this function should guess past.
 */
export async function enumerateNewFootage(campaign: Campaign): Promise<EnumerationResult> {
  if (!campaign.drive_folder_id) {
    throw new UnsupportedFootageSourceError(
      `Campaign ${campaign.id} has no Google Drive folder id — its footage source is either unresolved or on an unsupported platform`,
    );
  }

  const driveFiles = await listDriveFolderFiles(campaign.drive_folder_id);
  const alreadyKnown = await listDriveFileIdsForCampaign(campaign.id);

  let newJobsCreated = 0;
  let skippedNonVideo = 0;

  for (const file of driveFiles) {
    if (alreadyKnown.has(file.id)) continue;
    if (!isAcceptedVideoFile(file)) {
      skippedNonVideo++;
      continue;
    }

    const job = await createSourceJob({
      campaignId: campaign.id,
      driveFileId: file.id,
      driveFileName: file.name,
      sizeBytes: file.sizeBytes,
      md5Checksum: file.md5Checksum,
      sourceUrl: driveFileShareUrl(file.id),
    });
    if (job) newJobsCreated++;
  }

  return { newJobsCreated, filesSeen: driveFiles.length, skippedNonVideo };
}
