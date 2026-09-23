import type { Db } from "../../src/db/client.js";
import { campaigns, sourceJobs, type CampaignStatus, type SourceJobStatus } from "../../src/db/schema.js";

export async function insertCampaign(db: Db, crId = "cr-1", status: CampaignStatus = "discovered") {
  const [row] = await db
    .insert(campaigns)
    .values({
      contentRewardsCampaignId: crId,
      contentRewardsUrl: `https://contentrewards.com/discover/${crId}`,
      status,
      platforms: ["tiktok", "youtube"],
    })
    .returning();
  return row!;
}

export async function insertSourceJob(
  db: Db,
  campaignId: string,
  fileId = "drive-file-1",
  opts: { status?: SourceJobStatus; decision?: "selected" | "skipped" } = {},
) {
  const decision = opts.decision ?? "selected";
  const [row] = await db
    .insert(sourceJobs)
    .values({
      campaignId,
      sourceKey: `gdrive:${fileId}`,
      sourceKind: "gdrive_file",
      sourceName: `${fileId}.mp4`,
      sourceUrl: `https://drive.google.com/file/d/${fileId}/view`,
      decision,
      decisionReason: "test fixture",
      decidedBy: "claude-operator",
      status: opts.status ?? (decision === "skipped" ? "skipped" : "detected"),
      sizeBytes: 5_000_000_000, // > int32, exercises bigint
    })
    .returning();
  return row!;
}

/** Postgres error code from a failed drizzle call (drizzle wraps the driver error in `cause`). */
export async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

export const UNIQUE_VIOLATION = "23505";
export const CHECK_VIOLATION = "23514";
export const FK_VIOLATION = "23503";
export const NOT_NULL_VIOLATION = "23502";
