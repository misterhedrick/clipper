import { pool, withTransaction } from "../pool.js";
import { recordStatusEvent } from "../statusEvents.js";
import type { SourceJob, SourceJobStatus } from "../types.js";

function mapRow(row: any): SourceJob {
  return row;
}

export async function listDriveFileIdsForCampaign(campaignId: string): Promise<Set<string>> {
  const { rows } = await pool.query(`select drive_file_id from source_jobs where campaign_id = $1`, [campaignId]);
  return new Set(rows.map((r) => r.drive_file_id));
}

export interface CreateSourceJobInput {
  campaignId: string;
  driveFileId: string;
  driveFileName: string | null;
  sizeBytes: number | null;
  md5Checksum: string | null;
  sourceUrl: string;
}

/**
 * Inserts a new source_job in `detected` status. Relies on the
 * (campaign_id, drive_file_id) unique constraint as the real dedupe
 * guarantee — callers should still check listDriveFileIdsForCampaign first
 * to avoid noisy constraint-violation errors in the common case, but this
 * function is safe to call redundantly.
 */
export async function createSourceJob(input: CreateSourceJobInput): Promise<SourceJob | null> {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `insert into source_jobs (campaign_id, drive_file_id, drive_file_name, size_bytes, md5_checksum, source_url, status)
       values ($1, $2, $3, $4, $5, $6, 'detected')
       on conflict (campaign_id, drive_file_id) do nothing
       returning *`,
      [input.campaignId, input.driveFileId, input.driveFileName, input.sizeBytes, input.md5Checksum, input.sourceUrl],
    );
    if (!rows[0]) return null; // already existed — not a new job
    const job = mapRow(rows[0]);
    await recordStatusEvent(client, {
      entityType: "source_job",
      entityId: job.id,
      fromStatus: null,
      toStatus: "detected",
      actor: "system",
      reason: "New file found in campaign's Drive folder",
    });
    return job;
  });
}

export async function findSourceJobsByStatus(status: SourceJobStatus): Promise<SourceJob[]> {
  const { rows } = await pool.query(`select * from source_jobs where status = $1`, [status]);
  return rows.map(mapRow);
}

export async function findSourceJobByOpusClipProjectId(projectId: string): Promise<SourceJob | null> {
  const { rows } = await pool.query(`select * from source_jobs where opusclip_project_id = $1`, [projectId]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function findSourceJobById(id: string): Promise<SourceJob | null> {
  const { rows } = await pool.query(`select * from source_jobs where id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function transitionSourceJobStatus(
  id: string,
  toStatus: SourceJobStatus,
  actor: string,
  reason?: string,
  errorDetails?: unknown,
): Promise<SourceJob> {
  return withTransaction(async (client) => {
    const current = await client.query(`select status from source_jobs where id = $1`, [id]);
    const fromStatus = current.rows[0]?.status ?? null;
    const { rows } = await client.query(
      `update source_jobs set status = $2, status_reason = $3, updated_at = now() where id = $1 returning *`,
      [id, toStatus, reason ?? null],
    );
    await recordStatusEvent(client, {
      entityType: "source_job",
      entityId: id,
      fromStatus,
      toStatus,
      actor,
      reason,
      errorDetails,
    });
    return mapRow(rows[0]);
  });
}

export async function setOpusClipProjectId(id: string, projectId: string): Promise<SourceJob> {
  const { rows } = await pool.query(
    `update source_jobs set opusclip_project_id = $2, updated_at = now() where id = $1 returning *`,
    [id, projectId],
  );
  return mapRow(rows[0]);
}

export async function incrementRetryCount(id: string): Promise<SourceJob> {
  const { rows } = await pool.query(
    `update source_jobs set retry_count = retry_count + 1, updated_at = now() where id = $1 returning *`,
    [id],
  );
  return mapRow(rows[0]);
}
