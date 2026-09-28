import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { run } from "../../src/cli/run.js";
import { createDb, type Db } from "../../src/db/client.js";
import { campaigns, candidateClips, posts } from "../../src/db/schema.js";
import { transition } from "../../src/db/transition.js";
import { markPosted } from "../../src/modules/review/index.js";
import { MAX_PER_DAY, MIN_GAP_HOURS, nextSlot, POST_ACCOUNTS, youtubeTitle } from "../../src/modules/posting/index.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { validConfig } from "../helpers/config.js";
import { insertCampaign, insertSourceJob } from "../helpers/fixtures.js";

const PHRASE = "Pre-order Modern Warfare 4 today and play day one, October 23rd";
const CAPTION = `Clutch @callofduty\n${PHRASE}\n#mw4\n#Ad`;
const HOUR = 3_600_000;
const NOW = new Date("2026-09-28T12:00:00Z");
const [TIKTOK, INSTAGRAM, YOUTUBE] = POST_ACCOUNTS as unknown as [(typeof POST_ACCOUNTS)[number], (typeof POST_ACCOUNTS)[number], (typeof POST_ACCOUNTS)[number]];

describe("nextSlot", () => {
  const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
  it("takes the earliest time when the account is free", () => {
    expect(nextSlot([], NOW)).toEqual(NOW);
    expect(nextSlot([at(-4)], NOW)).toEqual(NOW);
  });
  it("keeps posts on one account at least 3 hours apart", () => {
    expect(nextSlot([at(-1)], NOW)).toEqual(at(MIN_GAP_HOURS - 1));
    expect(nextSlot([at(1)], NOW)).toEqual(at(4));
    expect(nextSlot([at(2), at(5)], NOW)).toEqual(at(8));
  });
  it("allows at most 4 posts in any 24 hours", () => {
    const four = [0, 3, 6, 9].map((h) => at(h));
    expect(nextSlot(four, NOW)).toEqual(at(24));
    expect(MAX_PER_DAY).toBe(4);
  });
});

describe("youtubeTitle", () => {
  it("uses the caption's first real line, never OpusClip's clip title, capped at 100 characters", () => {
    expect(youtubeTitle("A <great> clip\n#tag")).toBe("A great clip");
    expect(youtubeTitle("x".repeat(120))).toHaveLength(100);
    expect(youtubeTitle(CAPTION)).toBe("Clutch @callofduty");
    expect(youtubeTitle("#boxabl #tinyhome\n@boxabl\nA home that ships anywhere")).toBe("A home that ships anywhere");
  });
});

describe.skipIf(!TEST_DATABASE_URL)("clipper social …", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let hook: Server;
  let hookUrl: string;
  let delivered: { content?: string; text?: string }[] = [];
  let candidateId: string;
  let stdin = "";

  const env = () => ({ ...process.env, NOTIFY_WEBHOOK_URL: hookUrl, REVIEW_URL: "https://review.example" });
  const cli = (...argv: string[]) => run(argv, { db, env: env(), stdin: async () => stdin });
  const out = async (...argv: string[]) => (await cli(...argv)).output as any;
  const guard = async (tool: string, input: unknown) => {
    stdin = JSON.stringify({ tool_name: `mcp__OpusClip__opusclip_${tool}`, tool_input: input });
    return cli("guard", "post");
  };
  const sync = (list: unknown, ...flags: string[]) => {
    stdin = JSON.stringify(list);
    return out("social", "sync", "--file", "-", ...flags);
  };

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
    hook = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      delivered.push(JSON.parse(Buffer.concat(chunks).toString()));
      res.writeHead(200);
      res.end("ok");
    });
    await new Promise<void>((r) => hook.listen(0, "127.0.0.1", r));
    hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/services/T/B/X`;
  });
  afterAll(async () => {
    await new Promise((r) => hook.close(r));
    await pool?.end();
  });

  async function readyClip(opusId: string, jobKey: string, projectId = "P1") {
    const c = (await db.select().from(campaigns))[0] ?? (await insertCampaign(db, "cr-post", "active"));
    await db
      .update(campaigns)
      .set({ campaignType: "lf", title: "Modern Warfare 4", config: validConfig() as never, configConfirmedAt: new Date(), configConfirmedBy: "reviewer:test" })
      .where(eq(campaigns.id, c.id));
    const j = await insertSourceJob(db, c.id, jobKey, { status: "submitting" });
    await transition(db, { entity: "source_job", id: j.id, to: "project_created", actor: "claude-operator", set: { opusclipProjectId: projectId } });
    const [clip] = await db
      .insert(candidateClips)
      .values({ sourceJobId: j.id, opusclipClipId: opusId, title: "The one-shot", caption: CAPTION, status: "awaiting_review", packageKey: `ready-to-post/x/${opusId}/` })
      .returning();
    await transition(db, { entity: "candidate_clip", id: clip!.id, to: "approved", actor: "reviewer:test" });
    await transition(db, { entity: "candidate_clip", id: clip!.id, to: "ready_to_post", actor: "claude-operator" });
    return clip!.id;
  }

  beforeEach(async () => {
    await truncateAll(db);
    delivered = [];
    candidateId = await readyClip("c1", "file-1");
  });

  it("plans one post per account with the exact schedule params, once", async () => {
    const plan = await out("social", "plan", candidateId);
    expect(plan.posts).toHaveLength(3);
    const byPlatform = Object.fromEntries(plan.posts.map((p: any) => [p.platform, p]));
    const publishAt = byPlatform.tiktok.publishAt.replace(/\.\d{3}Z$/, "Z");
    expect(byPlatform.tiktok.params).toEqual({ projectId: "P1", clipId: "c1", postAccountId: TIKTOK.postAccountId, publishAt, title: CAPTION });
    expect(byPlatform.instagram.params).toMatchObject({ postAccountId: INSTAGRAM.postAccountId, subAccountId: INSTAGRAM.subAccountId, title: CAPTION, mediaType: "reel" });
    expect(byPlatform.youtube.params).toMatchObject({ postAccountId: YOUTUBE.postAccountId, title: "Clutch @callofduty", description: CAPTION, mediaType: "short" });
    expect(new Date(publishAt).getTime()).toBeGreaterThan(Date.now());

    const again = await out("social", "plan", candidateId);
    expect(again.posts.map((p: any) => p.postId).sort()).toEqual(plan.posts.map((p: any) => p.postId).sort());
    expect(await db.select().from(posts)).toHaveLength(3);
  });

  it("spaces a second clip 3 hours after the first on each account", async () => {
    const first = await out("social", "plan", candidateId);
    const second = await out("social", "plan", await readyClip("c2", "file-2", "P2"));
    for (const platform of ["tiktok", "instagram", "youtube"]) {
      const a = first.posts.find((p: any) => p.platform === platform);
      const b = second.posts.find((p: any) => p.platform === platform);
      expect(new Date(b.publishAt).getTime() - new Date(a.publishAt).getTime()).toBe(MIN_GAP_HOURS * HOUR);
    }
  });

  it("refuses clips that aren't packaged and ready to post", async () => {
    await db.update(candidateClips).set({ packageKey: null }).where(eq(candidateClips.id, candidateId));
    expect((await out("social", "plan", candidateId)).error.code).toBe("invalid_state");
  });

  describe("guard", () => {
    it("allows only the exact planned params, through schedule_publish", async () => {
      const plan = await out("social", "plan", candidateId);
      const tiktok = plan.posts.find((p: any) => p.platform === "tiktok");
      expect((await guard("schedule_publish", tiktok.params)).exitCode).toBe(0);

      expect((await guard("schedule_publish", { ...tiktok.params, title: "something else" })).exitCode).toBe(2);
      expect((await guard("schedule_publish", { ...tiktok.params, publishAt: "2026-09-28T13:00:00Z" })).exitCode).toBe(2);
      expect((await guard("schedule_publish", { ...tiktok.params, privacy: "private" })).exitCode).toBe(2);
      expect((await guard("schedule_publish", { ...tiktok.params, postAccountId: "someone-else" })).exitCode).toBe(2);
      expect((await guard("create_post_task", tiktok.params)).exitCode).toBe(2);
      stdin = "not json";
      expect((await cli("guard", "post")).exitCode).toBe(2);
    });

    it("blocks a post once it was requested, or when the clip isn't ready_to_post", async () => {
      const plan = await out("social", "plan", candidateId);
      const [a, b] = plan.posts;
      await out("social", "requested", a.postId, "--approval-url", "https://clip.opus.pro/approve/1");
      expect((await guard("schedule_publish", a.params)).exitCode).toBe(2);
      await db.update(candidateClips).set({ status: "archived" }).where(eq(candidateClips.id, candidateId));
      expect((await guard("schedule_publish", b.params)).exitCode).toBe(2);
    });

    it("blocks everything when nothing is planned", async () => {
      expect((await guard("schedule_publish", { projectId: "P1", clipId: "c1", postAccountId: TIKTOK.postAccountId, title: CAPTION, publishAt: "2026-09-28T13:00:00Z" })).exitCode).toBe(2);
    });
  });

  it("records the approval link, or frees the slot on an error", async () => {
    const plan = await out("social", "plan", candidateId);
    const [a, b] = plan.posts;
    expect(await out("social", "requested", a.postId, "--approval-url", "https://clip.opus.pro/approve/1")).toMatchObject({ status: "requested", approvalUrl: "https://clip.opus.pro/approve/1" });
    expect(await out("social", "requested", b.postId, "--error", "account disconnected")).toMatchObject({ status: "cancelled", failureReason: "account disconnected" });
    expect((await out("social", "requested", b.postId, "--approval-url", "https://x")).error.code).toBe("invalid_state");
    // A cancelled post doesn't hold its slot: planning again gives that account a fresh one.
    const again = await out("social", "plan", candidateId);
    const replanned = again.posts.find((p: any) => p.platform === b.platform);
    expect(replanned).toMatchObject({ status: "planned" });
    expect(replanned.postId).not.toBe(b.postId);
  });

  it("cancels a post the person never confirmed, and re-plans it in a fresh slot", async () => {
    const plan = await out("social", "plan", candidateId);
    const [a, b, c] = plan.posts;
    await out("social", "requested", a.postId, "--approval-url", "https://clip.opus.pro/approve/1");
    expect(await out("social", "cancel", a.postId, "--reason", "approval link expired")).toMatchObject({ status: "cancelled", failureReason: "approval link expired" });
    expect(await out("social", "cancel", b.postId, "--reason", "expired")).toMatchObject({ status: "cancelled" });
    expect((await out("social", "cancel", c.postId)).error.code).toBe("usage");
    await db.update(posts).set({ status: "scheduled" }).where(eq(posts.id, c.postId));
    expect((await out("social", "cancel", c.postId, "--reason", "x")).error.code).toBe("invalid_state");

    const again = await out("social", "plan", candidateId);
    expect(again.posts.map((p: any) => p.status).sort()).toEqual(["planned", "planned", "scheduled"]);
    expect(again.posts.find((p: any) => p.platform === a.platform).postId).not.toBe(a.postId);
  });

  it("syncs OpusClip's post statuses and sends new live links once", async () => {
    const plan = await out("social", "plan", candidateId);
    for (const p of plan.posts) await out("social", "requested", p.postId, "--approval-url", `https://clip.opus.pro/approve/${p.platform}`);

    const item = (account: string, status: string, extra: object = {}) => ({ clip_id: "c1", project_id: "P1", post_account_id: account, schedule_id: `s-${account}`, status, ...extra });
    const first = await sync({ posts: [item(TIKTOK.postAccountId, "scheduled"), item(INSTAGRAM.postAccountId, "scheduled"), item("stranger", "scheduled")] });
    expect(first.changes).toHaveLength(2);
    expect(first.unmatched).toHaveLength(1);
    expect(first.notified).toEqual({ sent: 0 });

    const live = await sync({
      posts: [
        item(TIKTOK.postAccountId, "posted", { post_url: "https://www.tiktok.com/@hedrick.clips/video/1" }),
        item(INSTAGRAM.postAccountId, "posted"), // link pending
        item(YOUTUBE.postAccountId, "failed", { failure_reason: "quota" }),
      ],
    });
    expect(live.notified.sent).toBe(1);
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("https://www.tiktok.com/@hedrick.clips/video/1");
    expect(delivered[0]!.text).toContain("https://contentrewards.com/discover/cr-post");
    const rows = Object.fromEntries((await db.select().from(posts)).map((p) => [p.platform, p]));
    expect(rows.tiktok).toMatchObject({ status: "posted", opusclipScheduleId: `s-${TIKTOK.postAccountId}` });
    expect(rows.instagram).toMatchObject({ status: "posted", url: null });
    expect(rows.youtube).toMatchObject({ status: "failed", failureReason: "quota" });

    // The Instagram link arrives later; only it is sent. The clip itself stays ready_to_post.
    const later = await sync({ posts: [item(INSTAGRAM.postAccountId, "posted", { post_url: "https://www.instagram.com/reel/abc" })] });
    expect(later.notified.sent).toBe(1);
    expect(delivered).toHaveLength(2);
    expect(delivered[1]!.text).not.toContain("tiktok.com");
    expect((await db.select().from(candidateClips).where(eq(candidateClips.id, candidateId)))[0]!.status).toBe("ready_to_post");
  });

  it("leaves marking the clip posted to a person, once a post is live", async () => {
    await out("social", "plan", candidateId);
    await expect(markPosted({ db, actor: "reviewer:test" }, candidateId)).rejects.toThrow(/No live post/);
    await sync({ posts: [{ clip_id: "c1", post_account_id: TIKTOK.postAccountId, status: "posted", post_url: "https://www.tiktok.com/@hedrick.clips/video/1" }] }, "--no-notify");
    await expect(markPosted({ db, actor: "claude-operator" }, candidateId)).rejects.toThrow();
    expect(await markPosted({ db, actor: "reviewer:test" }, candidateId)).toMatchObject({ status: "posted" });
  });
});
