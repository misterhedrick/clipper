import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { run } from "../../src/cli/run.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditLog, campaigns, candidateClips, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { transition } from "../../src/db/transition.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { validConfig } from "../helpers/config.js";
import { insertCampaign, insertSourceJob } from "../helpers/fixtures.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/opusclip-list-clips.json", import.meta.url), "utf8"));
const PHRASE = "Pre-order Modern Warfare 4 today and play day one, October 23rd";
const CAPTION = `This flank was disgusting @callofduty\n${PHRASE}\n#mw4 #cod\n#Ad`;

describe.skipIf(!TEST_DATABASE_URL)("clipper candidate …", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let jobId: string;
  let stdin = "";
  const cli = (...argv: string[]) => run(argv, { db, stdin: async () => stdin });
  const out = async (...argv: string[]) => (await cli(...argv)).output as any;
  const upsert = (body: unknown, job = jobId) => {
    stdin = JSON.stringify(body);
    return out("candidate", "upsert", job, "--file", "-");
  };
  const job = async () => (await db.select().from(sourceJobs).where(eq(sourceJobs.id, jobId)))[0]!;
  const clip = async (opusId: string) => (await db.select().from(candidateClips).where(eq(candidateClips.opusclipClipId, opusId)))[0]!;

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    const c = await insertCampaign(db, "cr-cand", "active");
    await db
      .update(campaigns)
      .set({ campaignType: "lf", config: validConfig() as never, configConfirmedAt: new Date(), configConfirmedBy: "reviewer:test" })
      .where(eq(campaigns.id, c.id));
    const j = await insertSourceJob(db, c.id, "file-1", { status: "submitting" });
    await transition(db, { entity: "source_job", id: j.id, to: "project_created", actor: "claude-operator", set: { opusclipProjectId: "P123" } });
    jobId = j.id;
  });

  describe("upsert", () => {
    it("creates each candidate once however often the same result is upserted", async () => {
      const first = await upsert(fixture);
      expect(first).toMatchObject({ created: 3, refreshed: 0, stageKind: "done", jobStatus: "candidates_ready" });
      const second = await upsert(fixture);
      expect(second).toMatchObject({ created: 0, refreshed: 3, jobStatus: "candidates_ready" });

      expect(await db.select().from(candidateClips)).toHaveLength(3);
      const created = await db.select().from(statusEvents).where(and(eq(statusEvents.entityType, "candidate_clip"), eq(statusEvents.toStatus, "awaiting_review")));
      expect(created).toHaveLength(3);
      expect(await job()).toMatchObject({ status: "candidates_ready", opusclipStage: "COMPLETE" });
    });

    it("stores OpusClip's metadata and runs the objective checks (wrong aspect fails)", async () => {
      await upsert(fixture);
      expect(await clip("P123.c1")).toMatchObject({
        status: "awaiting_review",
        title: "The one-shot nobody saw coming",
        hashtags: "#mw4 #cod",
        durationMs: 32000,
        opusclipScore: "92",
        opusclipSubScores: { hook: 9.1, coherence: 8.4, connection: 7.9, trend: 6.5 },
        thumbnailUrl: "https://cdn.opus.pro/P123/c1/thumb.jpg",
        checkResults: { duration: "pass", aspect_ratio: "pass", caption_compliance: "manual_review_required" },
      });
      expect((await clip("P123.c2")).checkResults).toMatchObject({ aspect_ratio: "fail", duration: "pass" });
      expect((await clip("P123.c3")).checkResults).toMatchObject({ aspect_ratio: "manual_review_required", duration: "fail" });
    });

    it("keeps a job processing while OpusClip works, and flags it after 6 hours with nothing", async () => {
      expect(await upsert({ stage: "CURATING", clips: [] })).toMatchObject({ created: 0, jobStatus: "processing" });
      expect(await upsert({ stage: "CURATING", clips: [] })).toMatchObject({ jobStatus: "processing" });
      // Only one project_created → processing event, not one per poll.
      const events = await db.select().from(statusEvents).where(and(eq(statusEvents.entityId, jobId), eq(statusEvents.toStatus, "processing")));
      expect(events).toHaveLength(1);

      await db
        .update(statusEvents)
        .set({ createdAt: new Date(Date.now() - 7 * 3_600_000) })
        .where(and(eq(statusEvents.entityId, jobId), eq(statusEvents.toStatus, "project_created")));
      expect(await upsert({ stage: "CURATING", clips: [] })).toMatchObject({ jobStatus: "needs_attention" });
      expect((await job()).statusReason).toMatch(/no clips 7h after the project was recorded/);
    });

    it("sends failed and empty-but-finished projects to needs_attention", async () => {
      expect(await upsert({ stage: "FAILED", clips: [] })).toMatchObject({ jobStatus: "needs_attention" });
      expect((await job()).statusReason).toMatch(/stage "FAILED"/);
    });

    it("stores clips that arrive mid-processing without closing the job", async () => {
      const partial = { stage: "RENDERING", clips: fixture.clips.slice(0, 1) };
      expect(await upsert(partial)).toMatchObject({ created: 1, jobStatus: "processing" });
      expect(await upsert(fixture)).toMatchObject({ created: 2, refreshed: 1, jobStatus: "candidates_ready" });
    });

    it("refuses clips from another project, jobs without a project, and bad input", async () => {
      expect(await upsert({ ...fixture, project_id: "OTHER" })).toMatchObject({ error: { code: "invalid_argument", message: expect.stringContaining("OTHER") } });
      expect(await upsert({ stage: "x" })).toMatchObject({ error: { code: "invalid_argument" } });
      const c2 = (await db.select().from(campaigns))[0]!;
      const queued = await insertSourceJob(db, c2.id, "file-2", { status: "queued" });
      expect(await upsert(fixture, queued.id)).toMatchObject({ error: { code: "invalid_state" } });
      expect(await db.select().from(candidateClips)).toHaveLength(0);
    });

    it("refuses a clip ID already stored for another job", async () => {
      await upsert(fixture);
      const c = (await db.select().from(campaigns))[0]!;
      const other = await insertSourceJob(db, c.id, "file-2", { status: "submitting" });
      await transition(db, { entity: "source_job", id: other.id, to: "project_created", actor: "claude-operator", set: { opusclipProjectId: "P999" } });
      expect(await upsert({ stage: "COMPLETE", clips: [{ clip_id: "P123.c1" }] }, other.id)).toMatchObject({ error: { code: "conflict" } });
    });
  });

  describe("operator's advisory work", () => {
    let id: string;
    beforeEach(async () => {
      await upsert(fixture);
      id = (await clip("P123.c1")).id;
    });

    it("list shows candidates with their checks", async () => {
      const listed = await out("candidate", "list", "--status", "awaiting_review", "--job", jobId);
      expect(listed.candidates).toHaveLength(3);
      expect(listed.candidates[0]).toMatchObject({ opusclipProjectId: "P123", opusclipClipId: "P123.c1", score: 92, prescreen: null });
      expect(await out("candidate", "list", "--status", "bogus")).toMatchObject({ error: { code: "invalid_argument" } });
    });

    it("prescreen records an advisory verdict and changes no status", async () => {
      expect(await out("candidate", "prescreen", id, "--verdict", "recommend", "--notes", "Clutch round, on-brief")).toMatchObject({
        status: "awaiting_review",
        prescreen: { verdict: "recommend" },
      });
      expect(await clip("P123.c1")).toMatchObject({ status: "awaiting_review", prescreenVerdict: "recommend" });
      expect(await out("candidate", "prescreen", id, "--verdict", "approve", "--notes", "x")).toMatchObject({ error: { code: "invalid_argument" } });
      expect(await db.select().from(auditLog).where(eq(auditLog.action, "prescreen"))).toHaveLength(1);
    });

    it("set-caption stores a compliant caption and marks the caption check passed", async () => {
      stdin = CAPTION;
      expect(await out("candidate", "set-caption", id, "--file", "-")).toMatchObject({ caption: CAPTION, checkResults: { caption_compliance: "pass" } });
      // A later refresh from OpusClip keeps the passed caption check.
      await upsert(fixture);
      expect((await clip("P123.c1")).checkResults).toMatchObject({ caption_compliance: "pass" });
    });

    it("set-caption rejects a caption missing a rule, with each reason, and stores nothing", async () => {
      stdin = CAPTION.replace("\n#Ad", "").replace(" @callofduty", "");
      const res = await cli("candidate", "set-caption", id, "--file", "-");
      expect(res.exitCode).toBe(1);
      expect(res.output).toMatchObject({
        error: {
          code: "caption_invalid",
          issues: [
            { rule: "required_tag", message: "missing required tag @callofduty" },
            { rule: "disclosure", message: 'missing disclosure "#Ad" (on its own line)' },
          ],
        },
      });
      expect((await clip("P123.c1")).caption).toBeNull();
    });

    it("record-edit is refused unless a reviewer marked the candidate needs_edit", async () => {
      stdin = JSON.stringify([{ op: "delete_phrase", phrase: "damn" }]);
      expect(await out("candidate", "record-edit", id, "--ops-file", "-", "--reason", "cut the swear")).toMatchObject({ error: { code: "invalid_state" } });

      await transition(db, { entity: "candidate_clip", id, to: "needs_edit", actor: "reviewer:test", reason: "cut the swear at 0:12" });
      expect(await out("candidate", "record-edit", id, "--ops-file", "-", "--reason", "reviewer: cut the swear at 0:12 → delete_phrase 'damn'")).toMatchObject({
        status: "awaiting_review",
        edits: 1,
      });
      expect(await clip("P123.c1")).toMatchObject({
        status: "awaiting_review",
        editLog: [{ ops: [{ op: "delete_phrase", phrase: "damn" }], reason: expect.stringContaining("cut the swear") }],
      });
      stdin = "[]";
      expect(await out("candidate", "record-edit", id, "--ops-file", "-", "--reason", "x")).toMatchObject({ error: { code: "invalid_argument" } });
    });

    it("has no command that decides a clip's fate", async () => {
      for (const cmd of ["approve", "reject", "needs-edit", "post"]) {
        expect(await out("candidate", cmd, id)).toMatchObject({ error: { code: "usage" } });
      }
    });
  });

  describe("reject", () => {
    beforeEach(async () => {
      await upsert(fixture);
    });

    it("rejects listed clips or a campaign's waiting clips, only for a named person, recording who asked", async () => {
      const c1 = (await clip("P123.c1")).id;
      expect(await out("candidate", "reject", c1, "--reason", "logo")).toMatchObject({ error: { code: "usage" } });
      expect(await out("candidate", "reject", "--reason", "logo", "--requested-by", "alex")).toMatchObject({ error: { code: "invalid_argument" } });

      expect(await out("candidate", "reject", c1, "--reason", "MW4 logo", "--requested-by", "alex")).toMatchObject({ count: 1, rejected: [c1] });
      expect(await clip("P123.c1")).toMatchObject({ status: "rejected", reviewNotes: "MW4 logo" });
      const [ev] = await db.select().from(statusEvents).where(and(eq(statusEvents.entityId, c1), eq(statusEvents.toStatus, "rejected")));
      expect(ev).toMatchObject({ actor: "claude-operator", reason: "MW4 logo (requested by alex)" });

      // A listed clip that's already decided stops the lot.
      const c2 = (await clip("P123.c2")).id;
      expect(await out("candidate", "reject", c1, c2, "--reason", "x", "--requested-by", "alex")).toMatchObject({ error: { code: "invalid_state" } });
      expect(await clip("P123.c2")).toMatchObject({ status: "awaiting_review" });

      const [campaign] = await db.select({ campaignId: sourceJobs.campaignId }).from(sourceJobs).where(eq(sourceJobs.id, jobId));
      expect(await out("candidate", "reject", "--campaign", campaign!.campaignId, "--reason", "unusable", "--requested-by", "alex")).toMatchObject({ count: 2 });
      expect((await db.select().from(candidateClips)).map((x) => x.status)).toEqual(["rejected", "rejected", "rejected"]);
      expect(await out("candidate", "reject", "--campaign", campaign!.campaignId, "--reason", "unusable", "--requested-by", "alex")).toMatchObject({ count: 0 });
    });
  });
});
