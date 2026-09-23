import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { run } from "../../src/cli/run.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditLog, campaigns, candidateClips, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { transition } from "../../src/db/transition.js";
import { r2Store } from "../../src/modules/packaging/r2.js";
import { decideCandidate } from "../../src/modules/review/index.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { validConfig } from "../helpers/config.js";
import { startFakeS3, type FakeS3 } from "../helpers/fake-s3.js";
import { insertCampaign, insertSourceJob } from "../helpers/fixtures.js";

const PHRASE = "Pre-order Modern Warfare 4 today and play day one, October 23rd";
const CAPTION = `Clutch @callofduty\n${PHRASE}\n#mw4\n#Ad`;
const EXPORT = "https://cdn.opus.pro/P1/c1/export-hd.mp4?sig=abc";
const EXPIRED = "https://cdn.opus.pro/P1/c1/expired.mp4";
const THUMB = "https://cdn.opus.pro/P1/c1/thumb.jpg";
const VIDEO = Buffer.concat(Array.from({ length: 12 }, (_, i) => Buffer.alloc(1024 * 1024, i))); // 12 MB → multipart

/** OpusClip's CDN (faked) plus anything on 127.0.0.1 (the webhook receiver) passed through to real fetch. */
const cdn = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if (url.startsWith("http://127.0.0.1")) return fetch(input, init);
  if (url === EXPORT) {
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (i >= VIDEO.length) return c.close();
        c.enqueue(new Uint8Array(VIDEO.subarray(i, i + 256 * 1024)));
        i += 256 * 1024;
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "video/mp4" } });
  }
  if (url === THUMB) return new Response(Buffer.from("JPEGDATA"), { status: 200, headers: { "content-type": "image/jpeg" } });
  if (url.includes("drive.google.com")) {
    const res = new Response("sign in", { status: 200 });
    Object.defineProperty(res, "url", { value: "https://accounts.google.com/ServiceLogin" });
    return res;
  }
  return new Response("gone", { status: 403 });
}) as typeof fetch;

describe.skipIf(!TEST_DATABASE_URL)("packaging and notifications", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let s3: FakeS3;
  let hook: Server;
  let hookUrl: string;
  let delivered: unknown[] = [];
  let hookStatus = 200;
  let campaignId: string;
  let jobId: string;
  let candidateId: string;

  const env = () => ({ ...process.env, NOTIFY_WEBHOOK_URL: hookUrl, REVIEW_URL: "https://review.example" });
  const cli = (...argv: string[]) => run(argv, { db, connector: { fetch: cdn }, env: env(), bundleStore: r2Store({ R2_ACCOUNT_ID: "a", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET_NAME: "clips" }, { endpoint: s3.endpoint }) });
  const out = async (...argv: string[]) => (await cli(...argv)).output as any;
  const clip = async () => (await db.select().from(candidateClips).where(eq(candidateClips.id, candidateId)))[0]!;

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
    s3 = await startFakeS3();
    hook = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      delivered.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(hookStatus);
      res.end(hookStatus === 200 ? "ok" : "no_service");
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/services/T/B/X`;
  });
  afterAll(async () => {
    await s3.close();
    await new Promise((r) => hook.close(r));
    await pool?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    s3.objects.clear();
    delivered = [];
    hookStatus = 200;
    const c = await insertCampaign(db, "cr-pkg", "active");
    await db
      .update(campaigns)
      .set({ title: "Call of Duty – MW4 Béta", campaignType: "lf", config: validConfig() as never, configConfirmedAt: new Date(), configConfirmedBy: "reviewer:sam" })
      .where(eq(campaigns.id, c.id));
    campaignId = c.id;
    const job = await insertSourceJob(db, c.id, "f1", { status: "submitting" });
    await db.update(sourceJobs).set({ opusclipProjectId: "P1" }).where(eq(sourceJobs.id, job.id));
    jobId = job.id;
    const [row] = await db
      .insert(candidateClips)
      .values({ sourceJobId: job.id, opusclipClipId: "P1.c1", title: "The one-shot!", durationMs: 30_000, thumbnailUrl: THUMB, caption: CAPTION, status: "awaiting_review", checkResults: { duration: "pass" } })
      .returning();
    candidateId = row!.id;
  });

  const approve = () => decideCandidate({ db, actor: "reviewer:alex" }, candidateId, { decision: "approve", notes: "great" });

  describe("record-export + package", () => {
    it("writes the full bundle to R2 and moves the clip to ready_to_post", async () => {
      await approve();
      expect(await out("candidate", "record-export", candidateId, "--url", EXPORT)).toMatchObject({ exportUrl: EXPORT });
      const res = await out("package", candidateId);
      const prefix = `ready-to-post/call-of-duty-mw4-beta-${campaignId.slice(0, 8)}/the-one-shot-${candidateId.slice(0, 8)}/`;
      expect(res).toMatchObject({ status: "ready_to_post", packageKey: prefix, alreadyPackaged: false, files: { "final.mp4": { bytes: VIDEO.length } } });

      expect([...s3.objects.keys()].sort()).toEqual(["caption.txt", "clip-metadata.json", "final.mp4", "thumbnail.jpg"].map((f) => prefix + f));
      expect(s3.objects.get(`${prefix}final.mp4`)!.body.equals(VIDEO)).toBe(true);
      expect(s3.objects.get(`${prefix}caption.txt`)!.body.toString()).toBe(`${CAPTION}\n`);
      expect(s3.objects.get(`${prefix}thumbnail.jpg`)!.body.toString()).toBe("JPEGDATA");
      const meta = JSON.parse(s3.objects.get(`${prefix}clip-metadata.json`)!.body.toString());
      expect(meta).toMatchObject({
        candidateId,
        caption: CAPTION,
        campaign: { id: campaignId },
        source: { jobId },
        opusclip: { projectId: "P1", clipId: "P1.c1" },
        approval: { by: "reviewer:alex", notes: "great" },
        files: { "final.mp4": { bytes: VIDEO.length }, "thumbnail.jpg": { bytes: 8 } },
      });

      expect(await clip()).toMatchObject({ status: "ready_to_post", packageKey: prefix });
      const moves = await db.select().from(statusEvents).where(eq(statusEvents.entityId, candidateId));
      expect(moves.map((e) => e.toStatus)).toEqual(["approved", "exporting", "ready_to_post"]);

      expect(await out("package", candidateId)).toMatchObject({ alreadyPackaged: true, packageKey: prefix });
    });

    it("refuses anything a reviewer didn't approve", async () => {
      expect(await out("candidate", "record-export", candidateId, "--url", EXPORT)).toMatchObject({ error: { code: "invalid_state" } });
      expect(await out("package", candidateId)).toMatchObject({ error: { code: "invalid_state", message: expect.stringContaining("awaiting_review") } });

      // Even with the status column forced to approved, no reviewer approval on record → refused.
      await db.execute(`update candidate_clips set status = 'approved', export_url = '${EXPORT}' where id = '${candidateId}'` as never);
      expect(await out("package", candidateId)).toMatchObject({ error: { code: "invalid_state", message: expect.stringContaining("no approval by a reviewer") } });
      expect(s3.objects.size).toBe(0);
    });

    it("needs an https export URL, and recovers from an expired one", async () => {
      await approve();
      expect(await out("candidate", "record-export", candidateId, "--url", "http://x/y.mp4")).toMatchObject({ error: { code: "invalid_argument" } });
      expect(await out("package", candidateId)).toMatchObject({ error: { code: "invalid_state", message: expect.stringContaining("record-export") } });

      await out("candidate", "record-export", candidateId, "--url", EXPIRED);
      expect(await out("package", candidateId)).toMatchObject({ error: { code: "export_unavailable", message: expect.stringContaining("expired") } });
      expect(await clip()).toMatchObject({ status: "approved", packageKey: null });

      await out("candidate", "record-export", candidateId, "--url", EXPORT);
      expect(await out("package", candidateId)).toMatchObject({ status: "ready_to_post" });
    });

    it("packages without a thumbnail, saying so in the metadata", async () => {
      await db.update(candidateClips).set({ thumbnailUrl: null }).where(eq(candidateClips.id, candidateId));
      await approve();
      await out("candidate", "record-export", candidateId, "--url", EXPORT);
      const res = await out("package", candidateId);
      expect(res.files["thumbnail.jpg"]).toEqual({ missing: "OpusClip gave no thumbnail URL" });
      expect([...s3.objects.keys()].some((k) => k.endsWith("thumbnail.jpg"))).toBe(false);
    });
  });

  describe("notifications", () => {
    it("a forced validation failure is delivered once, with a link", async () => {
      await db.update(sourceJobs).set({ status: "detected", opusclipProjectId: null }).where(eq(sourceJobs.id, jobId));
      expect(await out("source", "validate", jobId)).toMatchObject({ status: "validation_failed" });

      expect(await out("attention", "list")).toMatchObject({ items: [expect.objectContaining({ kind: "job_validation_failed", id: jobId })] });
      const sent = await out("attention", "notify");
      expect(sent).toMatchObject({ sent: true, items: 1 });
      expect(delivered).toHaveLength(1);
      expect((delivered[0] as { text: string }).text).toMatch(/Clipper needs you \(1\):\n• validation failed: .*f1\.mp4: source_unreachable: requires Google sign-in[\s\S]*Review: https:\/\/review\.example/);

      // Same failure, next run: nothing new to send.
      expect(await out("attention", "notify")).toMatchObject({ sent: false, items: 0 });
      expect(delivered).toHaveLength(1);
      expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "notify"), eq(auditLog.entityId, jobId)))).toHaveLength(1);
    });

    it("nudges about configs waiting over 24 hours, not fresh ones", async () => {
      const pending = await insertCampaign(db, "cr-wait", "discovered");
      await transition(db, { entity: "campaign", id: pending.id, to: "pending_confirmation", actor: "claude-operator" });
      expect(await out("attention", "notify")).toMatchObject({ sent: false });

      await db.update(statusEvents).set({ createdAt: new Date(Date.now() - 25 * 3_600_000) }).where(eq(statusEvents.entityId, pending.id));
      expect(await out("attention", "notify")).toMatchObject({ sent: true, items: 1 });
      expect((delivered[0] as { text: string }).text).toMatch(/Config waiting for your confirmation for 25h/);
    });

    it("records nothing as notified when delivery fails, so the next run retries", async () => {
      await db.update(sourceJobs).set({ status: "detected" }).where(eq(sourceJobs.id, jobId));
      await out("source", "validate", jobId);
      hookStatus = 404;
      expect(await out("attention", "notify")).toMatchObject({ error: { code: "notify_failed", message: expect.stringContaining("HTTP 404") } });
      expect(await db.select().from(auditLog).where(eq(auditLog.action, "notify"))).toHaveLength(0);
      hookStatus = 200;
      expect(await out("attention", "notify")).toMatchObject({ sent: true, items: 1 });
    });

    it("clipper notify sends the operator's report", async () => {
      expect(await out("notify", "--message", "Operator run — Needs you: nothing")).toMatchObject({ delivered: true });
      expect(delivered).toEqual([{ text: "Operator run — Needs you: nothing" }]);
    });
  });
});
