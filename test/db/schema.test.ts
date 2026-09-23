import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import {
  candidateClips,
  campaigns,
  creditLedger,
  footageSources,
  opusUsageSnapshots,
  posts,
  sourceJobs,
  statusEvents,
} from "../../src/db/schema.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import {
  CHECK_VIOLATION,
  FK_VIOLATION,
  UNIQUE_VIOLATION,
  insertCampaign,
  insertSourceJob,
  pgErrorCode,
} from "../helpers/fixtures.js";

describe.skipIf(!TEST_DATABASE_URL)("database schema", () => {
  let db: Db;
  let pool: { end(): Promise<void> };

  beforeAll(async () => {
    // Applies every migration in order (v1 → drop Drive columns → v2) on an empty DB.
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
  });

  it("round-trips a row through every table", async () => {
    const campaign = await insertCampaign(db);
    expect(campaign.config).toEqual({});
    expect(campaign.platforms).toEqual(["tiktok", "youtube"]);

    const [source] = await db
      .insert(footageSources)
      .values({
        campaignId: campaign.id,
        kind: "gdrive_folder",
        url: "https://drive.google.com/drive/folders/abc",
        label: "Raw to edit",
        addedBy: "claude-operator",
        reason: "linked as Content Folder in the brief",
      })
      .returning();

    const job = await insertSourceJob(db, campaign.id);
    await db.update(sourceJobs).set({ footageSourceId: source!.id, submitParams: { videoUrl: "x" } }).where(eq(sourceJobs.id, job.id));
    expect(job.sizeBytes).toBe(5_000_000_000);

    const [clip] = await db
      .insert(candidateClips)
      .values({
        sourceJobId: job.id,
        opusclipClipId: "proj123.cur456",
        status: "awaiting_review",
        durationMs: 30_000,
        opusclipScore: "87.5",
        opusclipSubScores: { hook: 9, coherence: 8 },
        checkResults: { aspect_ratio: "pass", overlay_present: "manual_review_required" },
        prescreenVerdict: "recommend",
      })
      .returning();
    expect(clip!.editLog).toEqual([]);

    await db.insert(posts).values({ candidateClipId: clip!.id, platform: "tiktok", views: 100 });
    await db.insert(statusEvents).values({
      entityType: "candidate_clip",
      entityId: clip!.id,
      toStatus: "awaiting_review",
      actor: "system",
    });
    await db.insert(creditLedger).values({ sourceJobId: job.id, campaignId: campaign.id, creditsReserved: 10 });
    await db.insert(opusUsageSnapshots).values({
      used: 10,
      monthlyLimit: 900,
      resetAt: new Date("2026-10-01T00:00:00Z"),
      recordedBy: "claude-operator",
    });

    const [readClip] = await db.select().from(candidateClips).where(eq(candidateClips.id, clip!.id));
    expect(readClip!.opusclipSubScores).toEqual({ hook: 9, coherence: 8 });
    for (const table of [posts, statusEvents, creditLedger, opusUsageSnapshots, footageSources]) {
      expect(await db.select().from(table)).toHaveLength(1);
    }
  });

  it("rejects a duplicate (campaign_id, source_key)", async () => {
    const campaign = await insertCampaign(db);
    await insertSourceJob(db, campaign.id, "same-file");
    expect(await pgErrorCode(insertSourceJob(db, campaign.id, "same-file"))).toBe(UNIQUE_VIOLATION);
  });

  it("rejects a second decision on the same video, even skipped vs selected", async () => {
    const campaign = await insertCampaign(db);
    await insertSourceJob(db, campaign.id, "f", { decision: "skipped" });
    expect(await pgErrorCode(insertSourceJob(db, campaign.id, "f"))).toBe(UNIQUE_VIOLATION);
  });

  it("allows the same video under a different campaign", async () => {
    const a = await insertCampaign(db, "cr-a");
    const b = await insertCampaign(db, "cr-b");
    await insertSourceJob(db, a.id, "shared-file");
    await expect(insertSourceJob(db, b.id, "shared-file")).resolves.toBeDefined();
  });

  it("keeps skipped videos in the skipped status only", async () => {
    const campaign = await insertCampaign(db);
    expect(await pgErrorCode(insertSourceJob(db, campaign.id, "a", { decision: "skipped", status: "detected" }))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgErrorCode(insertSourceJob(db, campaign.id, "b", { decision: "selected", status: "skipped" }))).toBe(
      CHECK_VIOLATION,
    );
  });

  it("allows only one open credit reservation per job", async () => {
    const campaign = await insertCampaign(db);
    const job = await insertSourceJob(db, campaign.id);
    const reserve = () => db.insert(creditLedger).values({ sourceJobId: job.id, campaignId: campaign.id, creditsReserved: 10 });
    await reserve();
    expect(await pgErrorCode(reserve())).toBe(UNIQUE_VIOLATION);

    // Once closed, a new reservation is allowed (a retry after a released failure).
    await db.update(creditLedger).set({ status: "released", closedAt: new Date() });
    await expect(reserve()).resolves.toBeDefined();
  });

  it("requires closed_at exactly when a reservation is closed, and positive credits", async () => {
    const campaign = await insertCampaign(db);
    const job = await insertSourceJob(db, campaign.id);
    const base = { sourceJobId: job.id, campaignId: campaign.id };
    expect(await pgErrorCode(db.insert(creditLedger).values({ ...base, creditsReserved: 10, status: "consumed" }))).toBe(
      CHECK_VIOLATION,
    );
    expect(await pgErrorCode(db.insert(creditLedger).values({ ...base, creditsReserved: 0 }))).toBe(CHECK_VIOLATION);
  });

  it("rejects duplicate Content Rewards campaign IDs and OpusClip clip IDs", async () => {
    await insertCampaign(db, "cr-dup");
    expect(await pgErrorCode(insertCampaign(db, "cr-dup"))).toBe(UNIQUE_VIOLATION);

    const job = await insertSourceJob(db, (await insertCampaign(db)).id);
    const values = { sourceJobId: job.id, opusclipClipId: "p.c", status: "generated" as const };
    await db.insert(candidateClips).values(values);
    expect(await pgErrorCode(db.insert(candidateClips).values(values))).toBe(UNIQUE_VIOLATION);
  });

  it("rejects unknown vocabulary values", async () => {
    const campaign = await insertCampaign(db);
    expect(
      await pgErrorCode(db.update(campaigns).set({ status: "activ" as never }).where(eq(campaigns.id, campaign.id))),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(db.update(campaigns).set({ campaignType: "podcast" as never }).where(eq(campaigns.id, campaign.id))),
    ).toBe(CHECK_VIOLATION);
    expect(
      await pgErrorCode(
        db.insert(footageSources).values({ campaignId: campaign.id, kind: "kick" as never, url: "u", addedBy: "x", reason: "y" }),
      ),
    ).toBe(CHECK_VIOLATION);
  });

  it("requires a status_reason for failure states", async () => {
    const job = await insertSourceJob(db, (await insertCampaign(db)).id);
    expect(
      await pgErrorCode(db.update(sourceJobs).set({ status: "validation_failed" }).where(eq(sourceJobs.id, job.id))),
    ).toBe(CHECK_VIOLATION);
  });

  it("rejects a source job for a nonexistent campaign", async () => {
    expect(await pgErrorCode(insertSourceJob(db, "00000000-0000-0000-0000-000000000000"))).toBe(FK_VIOLATION);
  });
});
