import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { buildApp } from "../../src/app.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditLog, campaigns, candidateClips, posts, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { transition } from "../../src/db/transition.js";
import { confirmCampaign, decideCandidate } from "../../src/modules/review/index.js";
import { createSession } from "../../src/web/auth.js";
import { r2Store } from "../../src/modules/packaging/r2.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { validConfig } from "../helpers/config.js";
import { insertCampaign, insertSourceJob } from "../helpers/fixtures.js";

const TOKEN = "test-reviewer-token-0123456789";
const PHRASE = "Pre-order Modern Warfare 4 today and play day one, October 23rd";
const CAPTION = `Clutch @callofduty\n${PHRASE}\n#mw4\n#Ad`;
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();
const FORM = { "content-type": "application/x-www-form-urlencoded" };

describe.skipIf(!TEST_DATABASE_URL)("review web app", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let app: ReturnType<typeof buildApp>;
  let campaignId: string;
  let candidateId: string;

  const login = async (name = "alex", token = TOKEN) => {
    const res = await app.inject({ method: "POST", url: "/login", headers: FORM, payload: form({ name, token }) });
    const cookie = String(res.headers["set-cookie"] ?? "").split(";")[0]!;
    return { res, cookie };
  };
  const post = async (url: string, body: Record<string, string>, cookie: string, extra: Record<string, string> = {}) =>
    app.inject({ method: "POST", url, headers: { ...FORM, cookie, host: "review.test", ...extra }, payload: form(body) });
  const flash = (res: { headers: Record<string, unknown> }) => {
    const loc = new URL(String(res.headers.location), "http://x");
    return { path: loc.pathname, ok: loc.searchParams.get("ok"), error: loc.searchParams.get("error") };
  };
  const candidate = async () => (await db.select().from(candidateClips).where(eq(candidateClips.id, candidateId)))[0]!;
  const campaign = async () => (await db.select().from(campaigns).where(eq(campaigns.id, campaignId)))[0]!;
  const events = (entityId: string, to: string) =>
    db.select().from(statusEvents).where(and(eq(statusEvents.entityId, entityId), eq(statusEvents.toStatus, to)));

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
    app = buildApp({ db, reviewerToken: TOKEN });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
    await pool?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    // A campaign the operator drafted (pending), and a clip from an already-active one.
    const pending = await insertCampaign(db, "cr-pending", "pending_confirmation");
    await db.update(campaigns).set({ title: "Pending <b>campaign</b>", campaignType: "lf", config: validConfig() as never }).where(eq(campaigns.id, pending.id));
    campaignId = pending.id;

    const active = await insertCampaign(db, "cr-active", "active");
    await db
      .update(campaigns)
      .set({ title: "Active", campaignType: "lf", config: validConfig() as never, configConfirmedAt: new Date(), configConfirmedBy: "reviewer:sam" })
      .where(eq(campaigns.id, active.id));
    const job = await insertSourceJob(db, active.id, "f1", { status: "submitting" });
    await db.update(sourceJobs).set({ opusclipProjectId: "P1" }).where(eq(sourceJobs.id, job.id));
    const [c] = await db
      .insert(candidateClips)
      .values({
        sourceJobId: job.id,
        opusclipClipId: "P1.c1",
        title: "<script>alert(1)</script> clutch",
        durationMs: 30_000,
        previewUrl: "https://cdn.opus.pro/p.mp4",
        status: "awaiting_review",
        checkResults: { duration: "pass", aspect_ratio: "pass", caption_compliance: "manual_review_required" },
      })
      .returning();
    candidateId = c!.id;
  });

  describe("authentication", () => {
    it("sends anonymous readers to sign in and refuses anonymous writes", async () => {
      const get = await app.inject({ method: "GET", url: "/review" });
      expect(get.statusCode).toBe(303);
      expect(get.headers.location).toBe("/login?next=%2Freview");

      const res = await post(`/candidates/${candidateId}/decision`, { decision: "approve" }, "");
      expect(res.statusCode).toBe(401);
      const forged = await post(`/candidates/${candidateId}/decision`, { decision: "approve" }, `clipper_session=${createSession("wrong-secret-wrong-secret-1", "alex")}`);
      expect(forged.statusCode).toBe(401);
      const confirm = await post(`/campaigns/${campaignId}/confirm`, { checked: "yes", config: JSON.stringify(validConfig()) }, "");
      expect(confirm.statusCode).toBe(401);

      expect((await candidate()).status).toBe("awaiting_review");
      expect((await campaign()).status).toBe("pending_confirmation");
    });

    it("rejects a wrong token or bad name, and expired sessions", async () => {
      expect((await login("alex", "nope")).res.statusCode).toBe(401);
      expect((await login("alex smith", TOKEN)).res.statusCode).toBe(401);
      const stale = createSession(TOKEN, "alex", new Date(Date.now() - 13 * 3600_000));
      expect((await post(`/candidates/${candidateId}/decision`, { decision: "hold", notes: "x" }, `clipper_session=${stale}`)).statusCode).toBe(401);
    });

    it("throttles repeated failed sign-ins", async () => {
      // Its own app, so the failure counter doesn't lock out the other tests.
      const own = buildApp({ db, reviewerToken: TOKEN });
      const attempt = (token: string) => own.inject({ method: "POST", url: "/login", headers: FORM, payload: form({ name: "alex", token }) });
      for (let i = 0; i < 10; i++) expect((await attempt("nope")).statusCode).toBe(401);
      expect((await attempt(TOKEN)).statusCode).toBe(429);
      await own.close();
    });

    it("behind a proxy, throttles by the real client IP, not the proxy's", async () => {
      const own = buildApp({ db, reviewerToken: TOKEN, trustProxyHops: 1 });
      const attempt = (ip: string, token: string) =>
        own.inject({ method: "POST", url: "/login", remoteAddress: "10.0.0.1", headers: { ...FORM, "x-forwarded-for": ip }, payload: form({ name: "alex", token }) });
      for (let i = 0; i < 10; i++) await attempt("203.0.113.9", "nope");
      expect((await attempt("203.0.113.9", TOKEN)).statusCode).toBe(429);
      // The real reviewer, arriving through the same proxy from another IP, isn't locked out.
      expect((await attempt("198.51.100.7", TOKEN)).statusCode).toBe(303);
      await own.close();
    });

    it("signs in with a hardened cookie and serves pages with security headers", async () => {
      const { res, cookie } = await login("alex");
      expect(res.statusCode).toBe(303);
      expect(String(res.headers["set-cookie"])).toMatch(/HttpOnly; Secure; SameSite=Strict/);
      const home = await app.inject({ method: "GET", url: "/", headers: { cookie } });
      expect(home.statusCode).toBe(200);
      expect(home.headers["content-security-policy"]).toContain("default-src 'none'");
      expect(home.body).toContain("campaign config to confirm");
    });

    it("refuses cross-site posts even with a valid session", async () => {
      const { cookie } = await login();
      const res = await post(`/candidates/${candidateId}/decision`, { decision: "hold", notes: "x" }, cookie, { origin: "https://evil.example" });
      expect(res.statusCode).toBe(403);
      const sibling = await post(`/candidates/${candidateId}/decision`, { decision: "hold", notes: "x" }, cookie, { "sec-fetch-site": "same-site" });
      expect(sibling.statusCode).toBe(403);
      const nullOrigin = await post(`/candidates/${candidateId}/decision`, { decision: "hold", notes: "x" }, cookie, { origin: "null" });
      expect(nullOrigin.statusCode).toBe(403);
      const same = await post(`/candidates/${candidateId}/decision`, { decision: "hold", notes: "x" }, cookie, { origin: "http://review.test", "sec-fetch-site": "same-origin" });
      expect(same.statusCode).toBe(303);
    });

    it("escapes third-party text", async () => {
      const { cookie } = await login();
      const res = await app.inject({ method: "GET", url: `/candidates/${candidateId}`, headers: { cookie } });
      expect(res.body).not.toContain("<script>alert(1)</script>");
      expect(res.body).toContain("&lt;script&gt;alert(1)&lt;/script&gt; clutch");
      const list = await app.inject({ method: "GET", url: "/campaigns", headers: { cookie } });
      expect(list.body).toContain("Pending &lt;b&gt;campaign&lt;/b&gt;");
    });
  });

  describe("campaign confirmation", () => {
    it("activates a campaign with the reviewer recorded, only after the checkbox and a valid config", async () => {
      const { cookie } = await login("alex");
      const cfg = validConfig();
      expect(flash(await post(`/campaigns/${campaignId}/confirm`, { config: JSON.stringify(cfg) }, cookie)).error).toMatch(/Tick the box/);
      expect(flash(await post(`/campaigns/${campaignId}/confirm`, { checked: "yes", config: "{" }, cookie)).error).toMatch(/isn't valid JSON/);
      const bad = { ...cfg, review: { ...cfg.review, autoApprove: true } };
      expect(flash(await post(`/campaigns/${campaignId}/confirm`, { checked: "yes", config: JSON.stringify(bad) }, cookie)).error).toMatch(/autoApprove must be false/);
      expect((await campaign()).status).toBe("pending_confirmation");

      cfg.clipGeneration.maxDurationSeconds = 45;
      const ok = await post(`/campaigns/${campaignId}/confirm`, { checked: "yes", config: JSON.stringify(cfg) }, cookie);
      expect(flash(ok).ok).toMatch(/active/);
      expect(await campaign()).toMatchObject({ status: "active", configConfirmedBy: "reviewer:alex", config: { clipGeneration: { maxDurationSeconds: 45 } } });
      expect(await events(campaignId, "active")).toEqual([expect.objectContaining({ actor: "reviewer:alex", reason: "config confirmed with reviewer edits" })]);
    });

    it("refuses non-long-form campaigns, and can send a draft back or pause/resume", async () => {
      const { cookie } = await login("alex");
      await db.update(campaigns).set({ campaignType: "ugc" }).where(eq(campaigns.id, campaignId));
      expect(flash(await post(`/campaigns/${campaignId}/confirm`, { checked: "yes", config: JSON.stringify(validConfig()) }, cookie)).error).toMatch(/only long-form/);

      expect(flash(await post(`/campaigns/${campaignId}/request-changes`, { reason: "max duration is 45s per the brief" }, cookie)).ok).toBeTruthy();
      expect(await campaign()).toMatchObject({ status: "needs_attention", statusReason: expect.stringContaining("45s") });

      const active = (await db.select().from(campaigns).where(eq(campaigns.contentRewardsCampaignId, "cr-active")))[0]!;
      await post(`/campaigns/${active.id}/pause`, {}, cookie);
      await post(`/campaigns/${active.id}/resume`, {}, cookie);
      expect(await events(active.id, "paused")).toEqual([expect.objectContaining({ actor: "reviewer:alex" })]);
      expect(await events(active.id, "active")).toEqual([expect.objectContaining({ actor: "reviewer:alex" })]);
    });

    it("records an unchanged draft as confirmed as drafted", async () => {
      const { cookie } = await login("alex");
      // Round-trip the stored draft the way the page does (reordered keys, same content).
      const stored = (await campaign()).config as Record<string, unknown>;
      const reordered = Object.fromEntries(Object.entries(stored).reverse());
      await post(`/campaigns/${campaignId}/confirm`, { checked: "yes", config: JSON.stringify(reordered) }, cookie);
      expect(await events(campaignId, "active")).toEqual([expect.objectContaining({ reason: "config confirmed as drafted" })]);
    });

    it("can't be done by the operator, even calling the module directly", async () => {
      await expect(confirmCampaign({ db, actor: "claude-operator" }, campaignId, validConfig())).rejects.toMatchObject({ code: "human_only" });
    });
  });

  describe("clip decisions", () => {
    it("approves only with a compliant caption, recording the reviewer as actor", async () => {
      const { cookie } = await login("alex");
      expect(flash(await post(`/candidates/${candidateId}/decision`, { decision: "approve" }, cookie)).error).toMatch(/Set a caption/);

      expect(flash(await post(`/candidates/${candidateId}/caption`, { caption: "no rules followed" }, cookie)).error).toMatch(/missing required tag @callofduty/);
      expect(flash(await post(`/candidates/${candidateId}/caption`, { caption: CAPTION }, cookie)).ok).toBe("Caption saved.");
      expect(await db.select().from(auditLog).where(eq(auditLog.action, "set_caption"))).toEqual([expect.objectContaining({ actor: "reviewer:alex" })]);

      const res = await post(`/candidates/${candidateId}/decision`, { decision: "approve", notes: "great hook" }, cookie);
      expect(flash(res)).toMatchObject({ path: "/review", ok: "Approved." });
      expect(await candidate()).toMatchObject({ status: "approved", reviewNotes: "great hook" });
      expect(await events(candidateId, "approved")).toEqual([expect.objectContaining({ actor: "reviewer:alex", fromStatus: "awaiting_review" })]);
    });

    it("needs an explicit override, with notes, to approve over a failed check", async () => {
      const { cookie } = await login();
      await db.update(candidateClips).set({ caption: CAPTION, checkResults: { duration: "fail", aspect_ratio: "pass" } }).where(eq(candidateClips.id, candidateId));
      expect(flash(await post(`/candidates/${candidateId}/decision`, { decision: "approve", override: "yes" }, cookie)).error).toMatch(/Checks failed \(duration\)/);
      await post(`/candidates/${candidateId}/decision`, { decision: "approve", override: "yes", notes: "46s is fine, brand said so" }, cookie);
      expect((await candidate()).status).toBe("approved");
    });

    it("needs notes for needs edit, reject and hold; hold keeps the clip in review", async () => {
      const { cookie } = await login("alex");
      for (const decision of ["needs_edit", "reject", "hold"]) {
        expect(flash(await post(`/candidates/${candidateId}/decision`, { decision }, cookie)).error).toMatch(/required/);
      }
      await post(`/candidates/${candidateId}/decision`, { decision: "hold", notes: "ask the brand about the logo" }, cookie);
      expect(await candidate()).toMatchObject({ status: "awaiting_review", reviewNotes: "ask the brand about the logo" });
      expect(await db.select().from(auditLog).where(eq(auditLog.action, "hold"))).toEqual([expect.objectContaining({ actor: "reviewer:alex" })]);

      await post(`/candidates/${candidateId}/decision`, { decision: "needs_edit", notes: "cut the swear at 0:12" }, cookie);
      expect(await candidate()).toMatchObject({ status: "needs_edit", reviewNotes: "cut the swear at 0:12" });
      await post(`/candidates/${candidateId}/decision`, { decision: "reject", notes: "off-brief after all" }, cookie);
      expect((await candidate()).status).toBe("rejected");
      expect(await events(candidateId, "rejected")).toEqual([expect.objectContaining({ actor: "reviewer:alex", reason: "off-brief after all" })]);
    });

    it("can't be decided by the operator, even calling the module directly", async () => {
      await db.update(candidateClips).set({ caption: CAPTION }).where(eq(candidateClips.id, candidateId));
      await expect(decideCandidate({ db, actor: "claude-operator" }, candidateId, { decision: "approve" })).rejects.toMatchObject({ code: "human_only" });
      expect((await candidate()).status).toBe("awaiting_review");
    });
  });

  describe("posting", () => {
    it("records posts per platform; the first moves the clip to posted", async () => {
      const { cookie } = await login("alex");
      await db.update(candidateClips).set({ caption: CAPTION }).where(eq(candidateClips.id, candidateId));
      await decideCandidate({ db, actor: "reviewer:alex" }, candidateId, { decision: "approve" });
      expect(flash(await post(`/candidates/${candidateId}/posts`, { platform: "tiktok", url: "https://tiktok.com/@me/video/1" }, cookie)).error).toMatch(/ready_to_post/);

      await transition(db, { entity: "candidate_clip", id: candidateId, to: "ready_to_post", actor: "claude-operator" });
      expect(flash(await post(`/candidates/${candidateId}/posts`, { platform: "tiktok", url: "javascript:alert(1)" }, cookie)).error).toMatch(/https/);
      await post(`/candidates/${candidateId}/posts`, { platform: "tiktok", url: "https://tiktok.com/@me/video/1" }, cookie);
      await post(`/candidates/${candidateId}/posts`, { platform: "youtube", url: "https://youtube.com/shorts/abc", views: "1200" }, cookie);
      await post(`/candidates/${candidateId}/posts`, { platform: "tiktok", url: "https://tiktok.com/@me/video/1", views: "5000", earnings: "8.75" }, cookie);

      expect((await candidate()).status).toBe("posted");
      const rows = await db.select().from(posts).where(eq(posts.candidateClipId, candidateId));
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.platform === "tiktok")).toMatchObject({ views: 5000, earnings: "8.75" });
      expect(await events(candidateId, "posted")).toEqual([expect.objectContaining({ actor: "reviewer:alex" })]);
    });
  });

  it("links a packaged clip's bundle files with signed, expiring URLs", async () => {
    const withR2 = buildApp({ db, reviewerToken: TOKEN, bundles: r2Store({ R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "k", R2_SECRET_ACCESS_KEY: "s", R2_BUCKET_NAME: "clips" }) });
    await db.update(candidateClips).set({ packageKey: "ready-to-post/x/y/", packagedAt: new Date() }).where(eq(candidateClips.id, candidateId));
    const cookie = `clipper_session=${createSession(TOKEN, "alex")}`;
    const res = await withR2.inject({ method: "GET", url: `/candidates/${candidateId}`, headers: { cookie } });
    for (const f of ["final.mp4", "caption.txt", "thumbnail.jpg", "clip-metadata.json"]) {
      expect(res.body).toMatch(new RegExp(`href="https://acct\\.r2\\.cloudflarestorage\\.com/clips/ready-to-post/x/y/${f.replace(".", "\\.")}\\?[^"]*X-Amz-Signature=`));
    }
    await withR2.close();
  });

  it("renders every page for a signed-in reviewer", async () => {
    const { cookie } = await login();
    for (const url of ["/", "/campaigns", `/campaigns/${campaignId}`, "/review", "/review?status=approved", `/candidates/${candidateId}`, "/posts"]) {
      const res = await app.inject({ method: "GET", url, headers: { cookie } });
      expect(res.statusCode, url).toBe(200);
    }
    const missing = await app.inject({ method: "GET", url: "/candidates/00000000-0000-0000-0000-000000000000", headers: { cookie } });
    expect(missing.statusCode).toBe(404);
    expect((await app.inject({ method: "GET", url: "/candidates/not-a-uuid", headers: { cookie } })).statusCode).toBe(404);
  });
});
