import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { createDb, type Db } from "../../../src/db/client.js";
import { auditLog, campaigns, creditLedger, sourceJobs, statusEvents } from "../../../src/db/schema.js";
import {
  canonical,
  classifyConnectorError,
  guardSubmit,
  recordFailure,
  recordProject,
  reserve,
  uploadSource,
  validateSource,
  type SubmitCtx,
} from "../../../src/modules/submissions/index.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../../helpers/db.js";
import { validConfig } from "../../helpers/config.js";
import { insertCampaign, insertSourceJob } from "../../helpers/fixtures.js";

const ok = vi.fn(async (input: string | URL | Request) => {
  const res = new Response("ok", { status: 200 });
  Object.defineProperty(res, "url", { value: String(input) });
  return res;
}) as unknown as typeof fetch;

describe.skipIf(!TEST_DATABASE_URL)("submission protocol", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  const ctx = (over: Partial<SubmitCtx> = {}): SubmitCtx => ({ db, actor: "claude-operator", fetch: ok, dailyBudget: 120, ...over });

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

  /**
   * An active, confirmed long-form campaign (as if a reviewer confirmed it) with one
   * Drive job. A queued job is already uploaded to OpusClip unless `uploaded` is false.
   */
  async function setup(jobStatus: "detected" | "queued" = "queued", crId = "cr-sub", fileId = "file-1", uploaded = jobStatus === "queued") {
    const c = await insertCampaign(db, crId, "active");
    await db
      .update(campaigns)
      .set({ campaignType: "lf", config: validConfig() as never, configConfirmedAt: new Date(), configConfirmedBy: "reviewer:test" })
      .where(eq(campaigns.id, c.id));
    const job = await insertSourceJob(db, c.id, fileId, { status: jobStatus });
    if (uploaded) await db.update(sourceJobs).set({ opusclipUploadId: `UPL_${fileId}` }).where(eq(sourceJobs.id, job.id));
    return { campaignId: c.id, jobId: job.id };
  }
  const job = async (id: string) => (await db.select().from(sourceJobs).where(eq(sourceJobs.id, id)))[0]!;
  const ledger = () => db.select().from(creditLedger);
  const errCode = async (p: Promise<unknown>) => p.then(() => "resolved", (e) => (e as { code?: string }).code);

  describe("validate", () => {
    it("queues a reachable source", async () => {
      const { jobId } = await setup("detected");
      expect(await validateSource(ctx(), jobId)).toMatchObject({ status: "queued" });
      expect((await job(jobId)).status).toBe("queued");
    });

    it("fails a private source with a reason, and doesn't touch state on network errors", async () => {
      const { jobId } = await setup("detected");
      const signIn = vi.fn(async () => {
        const res = new Response("sign in", { status: 200 });
        Object.defineProperty(res, "url", { value: "https://accounts.google.com/ServiceLogin" });
        return res;
      }) as unknown as typeof fetch;
      const down = vi.fn(async () => {
        throw new TypeError("ECONNRESET");
      }) as unknown as typeof fetch;

      expect(await errCode(validateSource(ctx({ fetch: down }), jobId))).toBe("fetch_failed");
      expect((await job(jobId)).status).toBe("detected");

      expect(await validateSource(ctx({ fetch: signIn }), jobId)).toMatchObject({ status: "validation_failed" });
      expect(await job(jobId)).toMatchObject({ status: "validation_failed", statusReason: expect.stringContaining("sign-in") });
    });

    it("refuses while the campaign isn't confirmed and active", async () => {
      const { jobId, campaignId } = await setup("detected");
      await db.update(campaigns).set({ status: "paused" }).where(eq(campaigns.id, campaignId));
      expect(await errCode(validateSource(ctx(), jobId))).toBe("invalid_state");
    });
  });

  describe("reserve", () => {
    it("reserves credits, stores and returns the exact submit params, and audits it", async () => {
      const { jobId } = await setup();
      const r = await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      expect(r.credits).toBe(10);
      expect(r.submitParams).toEqual({
        videoUrl: "UPL_file-1",
        title: `clipper:${jobId}`,
        aspectRatio: "portrait",
        clipDurationsSec: [[15, 60]],
        enableCaption: true,
        rangeStart: 0,
        rangeEnd: 600,
      });
      expect(await job(jobId)).toMatchObject({ status: "submitting", submitParams: r.submitParams });
      expect(await ledger()).toEqual([expect.objectContaining({ status: "open", creditsReserved: 10 })]);
      expect((await db.select().from(auditLog)).map((a) => a.action)).toEqual(["reserve"]);
      expect((await db.select().from(statusEvents)).map((e) => e.toStatus)).toEqual(["submitting"]);
    });

    it("refuses to reserve the same job twice", async () => {
      const { jobId } = await setup();
      await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      expect(await errCode(reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" }))).toBe("invalid_state");
      expect(await ledger()).toHaveLength(1);
    });

    it("estimates 90 credits when the length is unknown, and uses --estimated-minutes when given", async () => {
      const a = await setup("queued", "cr-a", "a");
      const b = await setup("queued", "cr-b", "b");
      expect((await reserve(ctx({ dailyBudget: 1000 }), a.jobId, { opusRemaining: 900 })).credits).toBe(90);
      expect((await reserve(ctx({ dailyBudget: 1000 }), b.jobId, { opusRemaining: 900, estimatedMinutes: 58 })).credits).toBe(58);
    });

    it.each([
      ["today's budget", { dailyBudget: 50 }, { opusRemaining: 900 }],
      ["OpusClip's remaining credits", {}, { opusRemaining: 30, estimatedMinutes: 45 }],
    ])("refuses anything over %s, changing nothing", async (_label, ctxOver, input) => {
      const { jobId } = await setup();
      expect(await errCode(reserve(ctx(ctxOver), jobId, input))).toBe("budget_exceeded");
      expect(await job(jobId)).toMatchObject({ status: "queued", submitParams: null });
      expect(await ledger()).toHaveLength(0);
      expect(await db.select().from(statusEvents)).toHaveLength(0);
      expect(await db.select().from(auditLog)).toHaveLength(0);
    });

    it("enforces a campaign's own daily cap", async () => {
      const a = await setup("queued", "cr-cap", "a");
      const b = await insertSourceJob(db, a.campaignId, "b", { status: "queued" });
      await db.update(sourceJobs).set({ opusclipUploadId: "UPL_b" }).where(eq(sourceJobs.id, b.id));
      await db.update(campaigns).set({ maxDailyCredits: 15 });
      await reserve(ctx(), a.jobId, { opusRemaining: 900, range: "0-600" });
      expect(await errCode(reserve(ctx(), b.id, { opusRemaining: 900, range: "0-600" }))).toBe("budget_exceeded");
    });

    it("serializes concurrent reservations so the budget can't be overspent", async () => {
      const jobs = await Promise.all(["x1", "x2", "x3"].map((f, i) => setup("queued", `cr-${f}`, f).then((s) => s.jobId)));
      // Budget 25: room for two 10-credit reservations, not three.
      const results = await Promise.allSettled(jobs.map((id) => reserve(ctx({ dailyBudget: 25 }), id, { opusRemaining: 900, range: "0-600" })));
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
      expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason.code)).toEqual(["budget_exceeded"]);
    });

    it("requires a queued job in an active, confirmed campaign", async () => {
      const { jobId, campaignId } = await setup("detected");
      expect(await errCode(reserve(ctx(), jobId, { opusRemaining: 900 }))).toBe("invalid_state");
      await db.update(sourceJobs).set({ status: "queued" });
      await db.update(campaigns).set({ configConfirmedAt: null }).where(eq(campaigns.id, campaignId));
      expect(await errCode(reserve(ctx(), jobId, { opusRemaining: 900 }))).toBe("invalid_state");
    });
  });

  describe("record", () => {
    it("record-project consumes the reservation, and is idempotent for the same project", async () => {
      const { jobId } = await setup();
      await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      expect(await recordProject(ctx(), jobId, "P123")).toMatchObject({ status: "project_created", creditsConsumed: 10 });
      expect(await recordProject(ctx(), jobId, "P123")).toMatchObject({ alreadyRecorded: true });
      expect(await errCode(recordProject(ctx(), jobId, "P999"))).toBe("conflict");
      expect(await ledger()).toEqual([expect.objectContaining({ status: "consumed", closedAt: expect.any(Date) })]);
    });

    it("record-failure re-queues transient errors (max 3), then needs a person; the reservation is released each time", async () => {
      const { jobId } = await setup();
      for (const expected of ["queued", "queued", "needs_attention"]) {
        await reserve(ctx({ dailyBudget: 1000 }), jobId, { opusRemaining: 900, range: "0-600" });
        expect(await recordFailure(ctx(), jobId, "429 Too Many Requests")).toMatchObject({ status: expected, classification: "retryable" });
      }
      expect(await job(jobId)).toMatchObject({ retryCount: 3, submitParams: null });
      expect((await ledger()).map((l) => l.status)).toEqual(["released", "released", "released"]);
    });

    it("record-failure stops on permanent errors", async () => {
      const { jobId } = await setup();
      await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      expect(await recordFailure(ctx(), jobId, "Unsupported video URL")).toMatchObject({ status: "submit_failed", classification: "permanent" });
      expect(await job(jobId)).toMatchObject({ statusReason: expect.stringContaining("Unsupported") });
    });

    it("classifies connector errors", () => {
      for (const m of ["429", "Request timed out", "ETIMEDOUT", "Service Unavailable (503)", "Too many users have viewed this file"]) {
        expect(classifyConnectorError(m), m).toBe("retryable");
      }
      for (const m of ["Unsupported video URL", "Insufficient credits", "Video is private"]) {
        expect(classifyConnectorError(m), m).toBe("permanent");
      }
    });
  });

  describe("upload (Drive → OpusClip storage)", () => {
    const UPLOAD_URL = "https://storage.googleapis.com/ext.gcs.opus.pro/upload/UPL_new/video-raw.video?X-Goog-Signature=sig";
    const SESSION = "https://storage.googleapis.com/upload/session/abc";
    const KiB = 1024;

    /** Fake Drive (serves `size` bytes by range) and GCS resumable upload endpoint, recording what was sent. */
    function fakeServices(size: number, driveType = "video/mp4") {
      const file = new Uint8Array(size).map((_, i) => i % 251);
      const puts: { range: string; bytes: number }[] = [];
      const received: Uint8Array[] = [];
      const f = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        if (url.startsWith("https://drive.usercontent.google.com/download?id=")) {
          if (driveType.startsWith("text/html")) return new Response("<html>quota exceeded</html>", { status: 200, headers: { "content-type": driveType } });
          const [, a, b] = headers.get("range")!.match(/bytes=(\d+)-(\d+)/)!.map(Number);
          const end = Math.min(b!, size - 1);
          return new Response(file.slice(a!, end + 1), { status: 206, headers: { "content-type": driveType, "content-range": `bytes ${a}-${end}/${size}` } });
        }
        if (url === UPLOAD_URL && init?.method === "POST") {
          expect(headers.get("x-goog-resumable")).toBe("start");
          return new Response(null, { status: 201, headers: { location: SESSION } });
        }
        if (url === SESSION && init?.method === "PUT") {
          const range = headers.get("content-range")!;
          const body = init.body as Uint8Array;
          puts.push({ range, bytes: body.byteLength });
          received.push(body);
          const [, , end, total] = range.match(/bytes (\d+)-(\d+)\/(\d+)/)!.map(Number);
          return new Response(null, { status: end === total! - 1 ? 200 : 308 });
        }
        throw new Error(`unexpected request ${init?.method ?? "GET"} ${url}`);
      }) as unknown as typeof fetch;
      return { f, puts, received, file };
    }

    it("reserve refuses a Drive job that hasn't been uploaded", async () => {
      const { jobId } = await setup("queued", "cr-sub", "file-1", false);
      await expect(reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" })).rejects.toMatchObject({ code: "invalid_state", message: expect.stringContaining("source upload") });
      expect(await ledger()).toHaveLength(0);
    });

    it("copies the file in chunks, records the upload ID once, and reserve then submits the upload ID", async () => {
      const { jobId } = await setup("queued", "cr-sub", "file-1", false);
      const svc = fakeServices(600 * KiB);
      const res = await uploadSource({ db, actor: "claude-operator", fetch: svc.f }, jobId, { uploadUrl: UPLOAD_URL, uploadId: "UPL_new", chunkBytes: 256 * KiB });
      expect(res).toMatchObject({ uploadId: "UPL_new", bytes: 600 * KiB });
      expect(svc.puts).toEqual([
        { range: `bytes 0-${256 * KiB - 1}/${600 * KiB}`, bytes: 256 * KiB },
        { range: `bytes ${256 * KiB}-${512 * KiB - 1}/${600 * KiB}`, bytes: 256 * KiB },
        { range: `bytes ${512 * KiB}-${600 * KiB - 1}/${600 * KiB}`, bytes: 88 * KiB },
      ]);
      expect(Buffer.concat(svc.received).equals(Buffer.from(svc.file))).toBe(true);
      expect(await job(jobId)).toMatchObject({ opusclipUploadId: "UPL_new", sizeBytes: 600 * KiB, status: "queued" });
      expect(await db.select().from(auditLog).where(eq(auditLog.action, "upload"))).toHaveLength(1);

      const again = await uploadSource({ db, actor: "claude-operator", fetch: svc.f }, jobId, { uploadUrl: UPLOAD_URL, uploadId: "UPL_other" });
      expect(again).toMatchObject({ uploadId: "UPL_new", alreadyUploaded: true });

      const { submitParams } = await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      expect(submitParams.videoUrl).toBe("UPL_new");
    });

    it("only talks to OpusClip's storage, and refuses a Drive page that isn't the video", async () => {
      const { jobId } = await setup("queued", "cr-sub", "file-1", false);
      const upload = (f: typeof fetch, uploadUrl = UPLOAD_URL) => uploadSource({ db, actor: "claude-operator", fetch: f }, jobId, { uploadUrl, uploadId: "UPL_new" });
      const svc = fakeServices(10);
      await expect(upload(svc.f, "https://evil.example/upload")).rejects.toMatchObject({ code: "invalid_argument" });
      await expect(upload(svc.f, "http://storage.googleapis.com/x")).rejects.toMatchObject({ code: "invalid_argument" });
      expect(svc.f).not.toHaveBeenCalled();

      await expect(upload(fakeServices(10, "text/html; charset=utf-8").f)).rejects.toMatchObject({ code: "not_downloadable" });
      expect((await job(jobId)).opusclipUploadId).toBeNull();
    });

    it("validate re-queues a submit_failed job and drops its old upload", async () => {
      const { jobId } = await setup();
      await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      await recordFailure(ctx(), jobId, "Unsupported video link.");
      expect(await validateSource(ctx(), jobId)).toMatchObject({ status: "queued", next: "upload" });
      expect(await job(jobId)).toMatchObject({ status: "queued", opusclipUploadId: null });
      const events = await db.select().from(statusEvents).where(and(eq(statusEvents.entityId, jobId), eq(statusEvents.fromStatus, "submit_failed")));
      expect(events).toEqual([expect.objectContaining({ toStatus: "queued", reason: expect.stringContaining("re-validated after submit failure") })]);
    });
  });

  describe("guard", () => {
    const payload = (input: unknown) => JSON.stringify({ tool_name: "mcp__OpusClip__opusclip_submit_project", tool_input: input });

    it("allows only an exact match for an open reservation (key order doesn't matter)", async () => {
      const { jobId } = await setup();
      const { submitParams } = await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      const reordered = Object.fromEntries(Object.entries(submitParams).reverse());
      expect(await guardSubmit(db, payload(reordered))).toMatchObject({ allow: true, jobId });

      const cases: [string, unknown][] = [
        ["changed videoUrl", { ...submitParams, videoUrl: "https://drive.google.com/file/d/OTHER/view" }],
        ["added parameter", { ...submitParams, customPrompt: "make it viral" }],
        ["removed range", { ...submitParams, rangeStart: undefined, rangeEnd: undefined }],
        ["missing title", { ...submitParams, title: undefined }],
        ["foreign title", { ...submitParams, title: "my test" }],
      ];
      for (const [label, input] of cases) {
        expect((await guardSubmit(db, payload(input))).allow, label).toBe(false);
      }
      expect((await guardSubmit(db, "not json")).allow).toBe(false);
    });

    it("blocks once the reservation is closed, or if there never was one", async () => {
      const { jobId } = await setup();
      const noReservation = { videoUrl: "x", title: `clipper:${jobId}` };
      expect(await guardSubmit(db, payload(noReservation))).toMatchObject({ allow: false, reason: expect.stringContaining("reserve") });

      const { submitParams } = await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      await recordProject(ctx(), jobId, "P1");
      expect((await guardSubmit(db, payload(submitParams))).allow).toBe(false); // no second submit for the same video
    });

    it("canonical() ignores key order and undefined values", () => {
      expect(canonical({ b: 1, a: [{ d: 2, c: undefined }] })).toBe(canonical({ a: [{ d: 2 }], b: 1 }));
    });

    it("end to end: the real hook script allows the reserved call and blocks a tampered one", async () => {
      const { jobId } = await setup();
      const { submitParams } = await reserve(ctx(), jobId, { opusRemaining: 900, range: "0-600" });
      const runHook = (input: unknown) =>
        spawnSync(".claude/hooks/guard-opusclip-submit.sh", {
          input: payload(input),
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: TEST_DATABASE_URL, CLAUDE_PROJECT_DIR: process.cwd() },
        });
      const allowed = runHook(submitParams);
      expect(allowed.status, allowed.stderr).toBe(0);
      const blocked = runHook({ ...submitParams, videoUrl: "https://youtu.be/xxxxxxxxxxx" });
      expect(blocked.status).toBe(2);
      expect(blocked.stderr).toContain("differ from the reservation");
    }, 30_000);
  });
});
