import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createDb, type Db } from "../../src/db/client.js";
import { campaigns, candidateClips, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { OPERATOR_ACTOR, TransitionError, transition } from "../../src/db/transition.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { insertCampaign, insertSourceJob } from "../helpers/fixtures.js";

async function rejection(p: Promise<unknown>): Promise<TransitionError> {
  try {
    await p;
  } catch (e) {
    return e as TransitionError;
  }
  throw new Error("expected a rejection");
}

describe.skipIf(!TEST_DATABASE_URL)("transition()", () => {
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
    await truncateAll(db);
  });

  const events = (entityId: string) => db.select().from(statusEvents).where(eq(statusEvents.entityId, entityId));

  it("updates the status and writes the audit row together", async () => {
    const campaign = await insertCampaign(db);
    const result = await transition(db, {
      entity: "campaign",
      id: campaign.id,
      to: "needs_attention",
      actor: OPERATOR_ACTOR,
      reason: "guideline_doc_not_public",
      errorDetails: { http: 401 },
    });
    expect(result).toEqual({ from: "discovered", to: "needs_attention" });

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row).toMatchObject({ status: "needs_attention", statusReason: "guideline_doc_not_public" });
    expect(await events(campaign.id)).toEqual([
      expect.objectContaining({
        entityType: "campaign",
        fromStatus: "discovered",
        toStatus: "needs_attention",
        actor: OPERATOR_ACTOR,
        reason: "guideline_doc_not_public",
        errorDetails: { http: 401 },
      }),
    ]);
  });

  it("applies extra column updates in the same statement, but never lets them set status", async () => {
    const job = await insertSourceJob(db, (await insertCampaign(db, "c", "active")).id, "f", { status: "queued" });
    await transition(db, {
      entity: "source_job",
      id: job.id,
      to: "submitting",
      actor: OPERATOR_ACTOR,
      set: { submitParams: { videoUrl: "v" }, status: "completed" } as never,
    });
    const [row] = await db.select().from(sourceJobs).where(eq(sourceJobs.id, job.id));
    expect(row).toMatchObject({ status: "submitting", submitParams: { videoUrl: "v" } });
  });

  it("refuses transitions that aren't allowed, leaving no trace", async () => {
    const job = await insertSourceJob(db, (await insertCampaign(db)).id);
    const err = await rejection(transition(db, { entity: "source_job", id: job.id, to: "completed", actor: OPERATOR_ACTOR }));
    expect(err).toBeInstanceOf(TransitionError);
    expect(err.code).toBe("invalid_transition");
    const [row] = await db.select().from(sourceJobs).where(eq(sourceJobs.id, job.id));
    expect(row!.status).toBe("detected");
    expect(await events(job.id)).toHaveLength(0);
  });

  it("never lets automation activate a campaign or decide a clip", async () => {
    const campaign = await insertCampaign(db, "c", "pending_confirmation");
    for (const actor of [OPERATOR_ACTOR, "system", "reviewer:", "Reviewer:alex"]) {
      const err = await rejection(transition(db, { entity: "campaign", id: campaign.id, to: "active", actor }));
      expect(err.code).toBe("human_only");
    }
    await expect(
      transition(db, { entity: "campaign", id: campaign.id, to: "active", actor: "reviewer:alex" }),
    ).resolves.toEqual({ from: "pending_confirmation", to: "active" });

    const job = await insertSourceJob(db, campaign.id, "f", { status: "candidates_ready" });
    const [clip] = await db
      .insert(candidateClips)
      .values({ sourceJobId: job.id, opusclipClipId: "p.c", status: "awaiting_review" })
      .returning();
    for (const to of ["approved", "needs_edit", "rejected"] as const) {
      const err = await rejection(transition(db, { entity: "candidate_clip", id: clip!.id, to, actor: OPERATOR_ACTOR }));
      expect(err.code).toBe("human_only");
    }
  });

  it("lets automation return a failed packaging run to approved, and nothing else", async () => {
    const campaign = await insertCampaign(db, "c", "active");
    const job = await insertSourceJob(db, campaign.id, "f", { status: "candidates_ready" });
    const [clip] = await db
      .insert(candidateClips)
      .values({ sourceJobId: job.id, opusclipClipId: "p.c", status: "awaiting_review" })
      .returning();
    await transition(db, { entity: "candidate_clip", id: clip!.id, to: "approved", actor: "reviewer:alex" });
    await transition(db, { entity: "candidate_clip", id: clip!.id, to: "exporting", actor: OPERATOR_ACTOR });
    await expect(transition(db, { entity: "candidate_clip", id: clip!.id, to: "approved", actor: OPERATOR_ACTOR })).resolves.toEqual({
      from: "exporting",
      to: "approved",
    });
  });

  it("enforces an expectFrom precondition", async () => {
    const campaign = await insertCampaign(db);
    const err = await rejection(
      transition(db, {
        entity: "campaign",
        id: campaign.id,
        to: "pending_confirmation",
        actor: OPERATOR_ACTOR,
        expectFrom: ["requirements_drafted"],
      }),
    );
    expect(err.code).toBe("invalid_transition");
  });

  it("reports a missing entity", async () => {
    const err = await rejection(
      transition(db, { entity: "campaign", id: "00000000-0000-0000-0000-000000000000", to: "archived", actor: OPERATOR_ACTOR }),
    );
    expect(err.code).toBe("not_found");
  });

  it("is atomic: a failure after the status update rolls back both the update and the event", async () => {
    const campaign = await insertCampaign(db);
    // BigInt can't be serialized to JSON, so the audit insert fails *after* the status UPDATE has run.
    await expect(
      transition(db, {
        entity: "campaign",
        id: campaign.id,
        to: "needs_attention",
        actor: OPERATOR_ACTOR,
        reason: "x",
        errorDetails: { big: 1n },
      }),
    ).rejects.toThrow();

    const [row] = await db.select().from(campaigns).where(eq(campaigns.id, campaign.id));
    expect(row).toMatchObject({ status: "discovered", statusReason: null });
    expect(await events(campaign.id)).toHaveLength(0);
  });

  it("serializes concurrent transitions on the same row", async () => {
    const job = await insertSourceJob(db, (await insertCampaign(db, "c", "active")).id, "f", { status: "queued" });
    const attempt = () => transition(db, { entity: "source_job", id: job.id, to: "submitting", actor: OPERATOR_ACTOR });
    const results = await Promise.allSettled([attempt(), attempt()]);
    // Row lock: the second sees `submitting`, and submitting → submitting isn't allowed.
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(await events(job.id)).toHaveLength(1);
  });
});
