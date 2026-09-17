import { pool } from "../pool.js";

export interface CreatePostInput {
  candidateClipId: string;
  platform: "tiktok" | "instagram" | "youtube";
}

/** Created once a clip reaches ready_to_post, per README § "Prepare approved clips". */
export async function createPostRecord(input: CreatePostInput): Promise<void> {
  await pool.query(`insert into posts (candidate_clip_id, platform) values ($1, $2)`, [
    input.candidateClipId,
    input.platform,
  ]);
}

export interface RecordPostMetricsInput {
  postId: string;
  url?: string;
  postedAt?: Date;
  views?: number;
  likes?: number;
  engagementRate?: number;
  earnings?: number;
  notes?: string;
}

export async function recordPostMetrics(input: RecordPostMetricsInput): Promise<void> {
  await pool.query(
    `update posts set
       url = coalesce($2, url),
       posted_at = coalesce($3, posted_at),
       views = coalesce($4, views),
       likes = coalesce($5, likes),
       engagement_rate = coalesce($6, engagement_rate),
       earnings = coalesce($7, earnings),
       notes = coalesce($8, notes),
       updated_at = now()
     where id = $1`,
    [
      input.postId,
      input.url ?? null,
      input.postedAt ?? null,
      input.views ?? null,
      input.likes ?? null,
      input.engagementRate ?? null,
      input.earnings ?? null,
      input.notes ?? null,
    ],
  );
}
