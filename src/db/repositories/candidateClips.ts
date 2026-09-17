import { pool, withTransaction } from "../pool.js";
import { recordStatusEvent } from "../statusEvents.js";
import type { CandidateClip, CandidateClipStatus, CheckResult } from "../types.js";

function mapRow(row: any): CandidateClip {
  return { ...row, check_results: row.check_results ?? {} };
}

export interface UpsertCandidateClipInput {
  sourceJobId: string;
  opusclipClipId: string;
  title: string | null;
  durationMs: number | null;
  previewUrl: string | null;
  exportUrl: string | null;
  hashtags: string | null;
}

/**
 * Called from project-monitor after polling GET /api/exportable-clips.
 * Idempotent by opusclip_clip_id — safe to call on every poll tick.
 */
export async function upsertCandidateClip(input: UpsertCandidateClipInput): Promise<CandidateClip> {
  return withTransaction(async (client) => {
    const existing = await client.query(`select id, status from candidate_clips where opusclip_clip_id = $1`, [
      input.opusclipClipId,
    ]);

    if (existing.rows[0]) {
      const { rows } = await client.query(
        `update candidate_clips set title = $2, duration_ms = $3, preview_url = $4, export_url = $5, hashtags = $6, updated_at = now()
         where opusclip_clip_id = $1 returning *`,
        [input.opusclipClipId, input.title, input.durationMs, input.previewUrl, input.exportUrl, input.hashtags],
      );
      return mapRow(rows[0]);
    }

    const { rows } = await client.query(
      `insert into candidate_clips (source_job_id, opusclip_clip_id, title, duration_ms, preview_url, export_url, hashtags, status)
       values ($1, $2, $3, $4, $5, $6, $7, 'generated') returning *`,
      [input.sourceJobId, input.opusclipClipId, input.title, input.durationMs, input.previewUrl, input.exportUrl, input.hashtags],
    );
    const clip = mapRow(rows[0]);
    await recordStatusEvent(client, {
      entityType: "candidate_clip",
      entityId: clip.id,
      fromStatus: null,
      toStatus: "generated",
      actor: "system",
      reason: "Candidate retrieved from OpusClip",
    });
    return clip;
  });
}

export async function findCandidateClipsByStatus(status: CandidateClipStatus): Promise<CandidateClip[]> {
  const { rows } = await pool.query(`select * from candidate_clips where status = $1`, [status]);
  return rows.map(mapRow);
}

export async function findCandidateClipById(id: string): Promise<CandidateClip | null> {
  const { rows } = await pool.query(`select * from candidate_clips where id = $1`, [id]);
  return rows[0] ? mapRow(rows[0]) : null;
}

export async function setCheckResults(id: string, results: Record<string, CheckResult>): Promise<CandidateClip> {
  const { rows } = await pool.query(
    `update candidate_clips set check_results = $2, updated_at = now() where id = $1 returning *`,
    [id, JSON.stringify(results)],
  );
  return mapRow(rows[0]);
}

export async function transitionCandidateClipStatus(
  id: string,
  toStatus: CandidateClipStatus,
  actor: string,
  reason?: string,
): Promise<CandidateClip> {
  return withTransaction(async (client) => {
    const current = await client.query(`select status from candidate_clips where id = $1`, [id]);
    const fromStatus = current.rows[0]?.status ?? null;
    const { rows } = await client.query(
      `update candidate_clips set status = $2, updated_at = now() where id = $1 returning *`,
      [id, toStatus],
    );
    await recordStatusEvent(client, {
      entityType: "candidate_clip",
      entityId: id,
      fromStatus,
      toStatus,
      actor,
      reason,
    });
    return mapRow(rows[0]);
  });
}
