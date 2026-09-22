import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { candidateClips, campaigns, posts, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { resetTestDatabase, TEST_DATABASE_URL } from "../helpers/db.js";

// Postgres error codes
const UNIQUE_VIOLATION = "23505";
const CHECK_VIOLATION = "23514";
const FK_VIOLATION = "23503";

async function pgErrorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (e) {
    // drizzle wraps driver errors; the pg error is on `cause`.
    const err = e as { code?: string; cause?: { code?: string } };
    return err.cause?.code ?? err.code;
  }
  return undefined;
}

describe.skipIf(!TEST_DATABASE_URL)("database schema", () => {
  let db: Db;
  let pool: { end(): Promise<void> };

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
  });

  afterAll(async () => {
    await pool?.end();
  });

  beforeEach(async () => {
    await db.execute(
      sql`truncate posts, candidate_clips, source_jobs, status_events, campaigns restart identity cascade`,
    );
  });

  async function insertCampaign(crId = "cr-1") {
    const [row] = await db
      .insert(campaigns)
      .values({
        contentRewardsCampaignId: crId,
        contentRewardsUrl: `https://contentrewards.com/discover/${crId}`,
        status: "discovered",
        platforms: ["tiktok", "youtube"],
      })
      .returning();
    return row!;
  }

  async function insertSourceJob(campaignId: string, driveFileId = "drive-file-1") {
    const [row] = await db
      .insert(sourceJobs)
      .values({
        campaignId,
        driveFileId,
        sourceUrl: `https://drive.google.com/file/d/${driveFileId}/view`,
        status: "detected",
        sizeBytes: 5_000_000_000, // > int32, exercises bigint
      })
      .returning();
    return row!;
  }

  it("round-trips a row through every table", async () => {
    const campaign = await insertCampaign();
    expect(campaign.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(campaign.config).toEqual({});
    expect(campaign.platforms).toEqual(["tiktok", "youtube"]);

    const job = await insertSourceJob(campaign.id);
    expect(job.retryCount).toBe(0);
    expect(job.sizeBytes).toBe(5_000_000_000);

    const [clip] = await db
      .insert(candidateClips)
      .values({
        sourceJobId: job.id,
        opusclipClipId: "proj123.cur456",
        status: "awaiting_review",
        durationMs: 30_000,
        checkResults: { aspect_ratio: "pass", overlay_present: "manual_review_required" },
      })
      .returning();

    await db.insert(posts).values({ candidateClipId: clip!.id, platform: "tiktok", views: 100 });
    await db.insert(statusEvents).values({
      entityType: "candidate_clip",
      entityId: clip!.id,
      fromStatus: "checking",
      toStatus: "awaiting_review",
      actor: "system",
    });

    const [readClip] = await db.select().from(candidateClips).where(eq(candidateClips.id, clip!.id));
    expect(readClip!.checkResults).toEqual({
      aspect_ratio: "pass",
      overlay_present: "manual_review_required",
    });
    expect(await db.select().from(posts)).toHaveLength(1);
    expect(await db.select().from(statusEvents)).toHaveLength(1);
  });

  it("rejects a duplicate (campaign_id, drive_file_id) source job", async () => {
    const campaign = await insertCampaign();
    await insertSourceJob(campaign.id, "same-file");
    expect(await pgErrorCode(insertSourceJob(campaign.id, "same-file"))).toBe(UNIQUE_VIOLATION);
  });

  it("allows the same Drive file under a different campaign", async () => {
    const a = await insertCampaign("cr-a");
    const b = await insertCampaign("cr-b");
    await insertSourceJob(a.id, "shared-file");
    await expect(insertSourceJob(b.id, "shared-file")).resolves.toBeDefined();
  });

  it("rejects a duplicate Content Rewards campaign ID", async () => {
    await insertCampaign("cr-dup");
    expect(await pgErrorCode(insertCampaign("cr-dup"))).toBe(UNIQUE_VIOLATION);
  });

  it("rejects a duplicate OpusClip clip ID", async () => {
    const job = await insertSourceJob((await insertCampaign()).id);
    const values = { sourceJobId: job.id, opusclipClipId: "p.c", status: "generated" as const };
    await db.insert(candidateClips).values(values);
    expect(await pgErrorCode(db.insert(candidateClips).values(values))).toBe(UNIQUE_VIOLATION);
  });

  it("rejects unknown status values", async () => {
    const code = await pgErrorCode(
      db.insert(campaigns).values({
        contentRewardsCampaignId: "x",
        contentRewardsUrl: "https://contentrewards.com/discover/x",
        status: "activ" as never,
      }),
    );
    expect(code).toBe(CHECK_VIOLATION);
  });

  it("requires a status_reason for failure states", async () => {
    const job = await insertSourceJob((await insertCampaign()).id);
    const code = await pgErrorCode(
      db.update(sourceJobs).set({ status: "validation_failed" }).where(eq(sourceJobs.id, job.id)),
    );
    expect(code).toBe(CHECK_VIOLATION);

    await db
      .update(sourceJobs)
      .set({ status: "validation_failed", statusReason: "unsupported_extension" })
      .where(eq(sourceJobs.id, job.id));
  });

  it("rejects a source job for a nonexistent campaign", async () => {
    expect(await pgErrorCode(insertSourceJob("00000000-0000-0000-0000-000000000000"))).toBe(FK_VIOLATION);
  });
});
