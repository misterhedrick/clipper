import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { run } from "../../src/cli/run.js";
import { createDb, type Db } from "../../src/db/client.js";
import { campaigns, candidateClips, posts, statusEvents } from "../../src/db/schema.js";
import { transition } from "../../src/db/transition.js";
import { markPosted } from "../../src/modules/review/index.js";
import { MAX_PER_DAY, MIN_GAP_HOURS, MIN_SEPARATION_MINUTES, nextSlot, POST_ACCOUNTS, spacingWarnings, youtubeTitle } from "../../src/modules/posting/index.js";
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
  const min = (m: number) => new Date(NOW.getTime() + m * 60_000);
  it("takes the earliest time: the person decides when to post", () => {
    expect(nextSlot([], NOW)).toEqual(NOW);
    expect(nextSlot([at(-1)], NOW)).toEqual(NOW);
  });
  it("never puts two posts on one account in the same few minutes", () => {
    expect(nextSlot([min(3)], NOW)).toEqual(min(3 + MIN_SEPARATION_MINUTES));
    expect(nextSlot([min(-5)], NOW)).toEqual(min(5));
  });
});

describe("spacingWarnings", () => {
  const at = (h: number) => new Date(NOW.getTime() + h * HOUR);
  it("warns, without blocking, when a post breaks the 3h / 4-a-day guidance", () => {
    expect(spacingWarnings([at(-4)], NOW)).toEqual([]);
    expect(spacingWarnings([at(-1)], NOW)).toEqual([`1 other post within ${MIN_GAP_HOURS}h`]);
    expect(spacingWarnings([at(-20), at(-15), at(-10), at(-5)], NOW)).toEqual([`${MAX_PER_DAY + 1} posts in 24h (guideline ${MAX_PER_DAY})`]);
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

  it("posts a second clip right away, apart from the first and with a spacing warning", async () => {
    const first = await out("social", "plan", candidateId);
    expect(first.spacingWarnings).toBeUndefined();
    const second = await out("social", "plan", await readyClip("c2", "file-2", "P2"));
    for (const platform of ["tiktok", "instagram", "youtube"]) {
      const a = first.posts.find((p: any) => p.platform === platform);
      const b = second.posts.find((p: any) => p.platform === platform);
      expect(new Date(b.publishAt).getTime() - new Date(a.publishAt).getTime()).toBe(MIN_SEPARATION_MINUTES * 60_000);
    }
    expect(second.spacingWarnings).toHaveLength(3);
  });

  it("queues approved clips oldest approval first, and drops a clip once it's planned", async () => {
    const second = await readyClip("c2", "file-2", "P2");
    let q = (await out("social", "queue")).queue;
    expect(q.map((x: any) => x.candidateId)).toEqual([candidateId, second]);
    expect(q[0]).toMatchObject({ position: 1, status: "ready_to_post", packaged: true });
    await out("social", "plan", candidateId);
    q = (await out("social", "queue")).queue;
    expect(q.map((x: any) => x.candidateId)).toEqual([second]);
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

  it("sends every approval still in time to Discord as one link", async () => {
    expect(await out("social", "alert")).toEqual({ sent: 0 });
    const plan = await out("social", "plan", candidateId);
    const [a, b, c] = plan.posts;
    await out("social", "requested", a.postId, "--approval-url", "https://clip.opus.pro/agent-approvals#v2.AAA");
    await out("social", "requested", b.postId, "--approval-url", "https://clip.opus.pro/agent-approvals#v2.BBB");
    await out("social", "requested", c.postId, "--approval-url", "https://clip.opus.pro/agent-approvals#v2.CCC");
    await db.update(posts).set({ publishAt: new Date(Date.now() - 60_000) }).where(eq(posts.id, c.postId));

    const res = await out("social", "alert");
    expect(res).toMatchObject({ sent: 2, combinedUrl: "https://clip.opus.pro/agent-approvals#v2.AAA,v2.BBB" });
    expect(delivered).toHaveLength(1);
    expect(delivered[0]!.text).toContain("https://clip.opus.pro/agent-approvals#v2.AAA,v2.BBB");
    expect(delivered[0]!.text).not.toContain("CCC");
  });

  it("syncs OpusClip's post statuses and sends new live links once", async () => {
    const plan = await out("social", "plan", candidateId);
    for (const p of plan.posts) await out("social", "requested", p.postId, "--approval-url", `https://clip.opus.pro/approve/${p.platform}`);

    // The live shape (2026-09-28): platform, no account ID.
    const platformName: Record<string, string> = { [TIKTOK.postAccountId]: "TIKTOK_BUSINESS", [INSTAGRAM.postAccountId]: "INSTAGRAM_BUSINESS", [YOUTUBE.postAccountId]: "YOUTUBE", stranger: "FACEBOOK" };
    const item = (account: string, status: string, extra: object = {}) => ({ schedule_id: `s-${account}`, project_id: "P1", clip_id: "c1", publish_at: "2026-09-28T22:59:00.000Z", status, platform: platformName[account], ...extra });
    const first = await sync({ posts: [item(TIKTOK.postAccountId, "scheduled"), item(INSTAGRAM.postAccountId, "scheduled"), item("stranger", "scheduled")] });
    expect(first.changes).toHaveLength(2);
    expect(first.unmatched).toHaveLength(1);
    expect(first.notified).toEqual({ sent: 0 });
    expect(first.stillWaiting).toBe(3);

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
    expect(delivered[0]!.text).toContain("Whop (your profile → Joined");
    expect(live.stillWaiting).toBe(0);
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

  it("leaves marking the clip posted to a person while only some posts are live", async () => {
    await out("social", "plan", candidateId);
    await expect(markPosted({ db, actor: "reviewer:test" }, candidateId)).rejects.toThrow(/No live post/);
    const res = await sync({ posts: [{ clip_id: "c1", post_account_id: TIKTOK.postAccountId, status: "posted", post_url: "https://www.tiktok.com/@hedrick.clips/video/1" }] }, "--no-notify");
    expect(res.markedPosted).toEqual([]);
    await expect(markPosted({ db, actor: "claude-operator" }, candidateId)).rejects.toThrow();
    expect(await markPosted({ db, actor: "reviewer:test" }, candidateId)).toMatchObject({ status: "posted" });
  });

  describe("standing rule: every post live with a link → the clip is posted", () => {
    const url = { tiktok: "https://www.tiktok.com/@hedrick.clips/video/1", instagram: "https://www.instagram.com/reel/abc", youtube: "https://www.youtube.com/watch?v=abc" };
    const live = (account: string, post_url?: string) => ({ clip_id: "c1", post_account_id: account, status: "posted", ...(post_url ? { post_url } : {}) });
    const clipStatus = async () => (await db.select().from(candidateClips).where(eq(candidateClips.id, candidateId)))[0]!.status;

    it("marks the clip posted once the last link arrives, recording the rule and the links", async () => {
      await out("social", "plan", candidateId);
      // All three live, but Instagram's link hasn't arrived yet: wait.
      const first = await sync({ posts: [live(TIKTOK.postAccountId, url.tiktok), live(INSTAGRAM.postAccountId), live(YOUTUBE.postAccountId, url.youtube)] }, "--no-notify");
      expect(first.markedPosted).toEqual([]);
      expect(await clipStatus()).toBe("ready_to_post");

      const second = await sync({ posts: [live(INSTAGRAM.postAccountId, url.instagram)] }, "--no-notify");
      expect(second.markedPosted).toEqual([{ id: candidateId, links: expect.arrayContaining([`instagram: ${url.instagram}`]) }]);
      expect(await clipStatus()).toBe("posted");
      const [ev] = await db.select().from(statusEvents).where(and(eq(statusEvents.entityId, candidateId), eq(statusEvents.toStatus, "posted")));
      expect(ev).toMatchObject({ actor: "claude-operator", reason: expect.stringMatching(/tiktok: .*every post live with a link/) });

      // Idempotent: another sync changes nothing, and the person's button reports it as done.
      expect((await sync({ posts: [] }, "--no-notify")).markedPosted).toEqual([]);
      expect(await markPosted({ db, actor: "reviewer:test" }, candidateId)).toMatchObject({ alreadyPosted: true });
    });

    it("leaves a clip with a failed post for the person", async () => {
      await out("social", "plan", candidateId);
      const res = await sync(
        { posts: [live(TIKTOK.postAccountId, url.tiktok), live(INSTAGRAM.postAccountId, url.instagram), { clip_id: "c1", post_account_id: YOUTUBE.postAccountId, status: "failed" }] },
        "--no-notify",
      );
      expect(res.markedPosted).toEqual([]);
      expect(await clipStatus()).toBe("ready_to_post");
    });

    it("catches up a clip that went fully live before the rule existed, on the next sync", async () => {
      await out("social", "plan", candidateId);
      for (const [platform, u] of Object.entries(url)) {
        await db.update(posts).set({ status: "posted", url: u, postedAt: new Date() }).where(and(eq(posts.candidateClipId, candidateId), eq(posts.platform, platform as never)));
      }
      expect((await sync({ posts: [] }, "--no-notify")).markedPosted).toEqual([expect.objectContaining({ id: candidateId })]);
      expect(await clipStatus()).toBe("posted");
    });
  });
});
