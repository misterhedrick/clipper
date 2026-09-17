import { upsertCandidateClip } from "../../db/repositories/candidateClips.js";
import { transitionSourceJobStatus } from "../../db/repositories/sourceJobs.js";
import type { SourceJob } from "../../db/types.js";
import { getExportableClips } from "../../lib/opusclip.js";

/**
 * Polls GET /api/exportable-clips for a source_job's OpusClip project and
 * upserts each returned clip into candidate_clips. This is the source of
 * truth per ARCHITECTURE.md — the webhook receiver (server.ts) just
 * triggers this same function early rather than being trusted directly,
 * since OpusClip's webhook payload shape isn't fully documented (see
 * docs/API_CONTRACTS.md).
 */
export async function pollProjectClips(job: SourceJob): Promise<{ clipCount: number }> {
  if (!job.opusclip_project_id) {
    throw new Error(`source_job ${job.id} has no opusclip_project_id — cannot poll`);
  }

  const clips = await getExportableClips(job.opusclip_project_id);

  for (const clip of clips) {
    await upsertCandidateClip({
      sourceJobId: job.id,
      opusclipClipId: clip.id,
      title: clip.title,
      durationMs: clip.durationMs,
      previewUrl: clip.uriForPreview,
      exportUrl: clip.uriForExport,
      hashtags: clip.hashtags,
    });
  }

  if (clips.length > 0 && job.status !== "candidates_ready") {
    await transitionSourceJobStatus(job.id, "candidates_ready", "system", `${clips.length} candidate clip(s) retrieved`);
  } else if (clips.length === 0 && job.status === "project_created") {
    await transitionSourceJobStatus(job.id, "processing", "system", "Awaiting candidates from OpusClip");
  }

  return { clipCount: clips.length };
}
