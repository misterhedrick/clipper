import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { run } from "../../src/cli/run.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditLog, campaigns, statusEvents } from "../../src/db/schema.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { validConfig } from "../helpers/config.js";

const MW4 = "24ad920b-d24f-479e-9cef-f22182e4a0c0";
const campaignPage = readFileSync(new URL("../fixtures/content-rewards-campaign-page.html", import.meta.url), "utf8");
const listingPage = readFileSync(new URL("../fixtures/content-rewards-discover-listing.html", import.meta.url), "utf8");
const docExport = readFileSync(new URL("../fixtures/google-doc-export.html", import.meta.url), "utf8");

// Serves captured pages instead of hitting Content Rewards / Google Docs.
const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(input);
  if (url.includes("/document/d/PRIVATE/")) return new Response("", { status: 401 });
  const body = url.endsWith("/discover")
    ? listingPage
    : url.includes("docs.google.com/document/")
      ? docExport
      : url.includes(MW4)
        ? campaignPage
        : "";
  const res = new Response(body, { status: body ? 200 : 404 });
  Object.defineProperty(res, "url", { value: url });
  return res;
}) as unknown as typeof fetch;

describe.skipIf(!TEST_DATABASE_URL)("clipper campaign …", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let stdinText = "";
  const cli = (...argv: string[]) => run(argv, { db, connector: { fetch: fakeFetch }, stdin: async () => stdinText });
  const propose = (config: unknown, ...extra: string[]) => {
    stdinText = JSON.stringify(config);
    return cli("campaign", "propose-config", MW4, "--file", "-", ...extra);
  };

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

  it("add tracks a campaign once, with an audited initial status and a Content Rewards snapshot", async () => {
    const first = await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    expect(first.exitCode).toBe(0);
    expect(first.output).toMatchObject({
      created: true,
      campaign: { contentRewardsCampaignId: MW4, status: "discovered", brand: "Clipping Culture" },
      contentRewards: { status: "paused", requiresApplication: false },
    });

    const again = await cli("campaign", "add", `https://contentrewards.com/campaigns/${MW4}`);
    expect(again.output).toMatchObject({ created: false });
    expect((again.output as { campaign: { id: string } }).campaign.id).toBe(
      (first.output as { campaign: { id: string } }).campaign.id,
    );

    const rows = await db.select().from(campaigns);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.crSnapshot).toMatchObject({ campaignId: MW4, guidelineDocId: expect.any(String) });
    expect(await db.select().from(statusEvents)).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: "discovered", actor: "claude-operator" }),
    ]);
  });

  it("scout lists untracked campaigns by default and marks tracked ones with --all", async () => {
    const before = (await cli("campaign", "scout")).output as { listed: number; campaigns: unknown[] };
    expect(before.listed).toBe(3);
    expect(before.campaigns).toHaveLength(3);

    await db.insert(campaigns).values({
      contentRewardsCampaignId: "86842687-ba2b-4638-a024-995dcf3d25a3",
      contentRewardsUrl: "https://contentrewards.com/discover/86842687-ba2b-4638-a024-995dcf3d25a3",
      status: "discovered",
    });
    const after = (await cli("campaign", "scout")).output as { tracked: number; campaigns: { title: string }[] };
    expect(after.tracked).toBe(1);
    expect(after.campaigns.map((c) => c.title)).not.toContain("Michael Sartain's Clipping Army");

    const all = (await cli("campaign", "scout", "--all")).output as { campaigns: { tracked: unknown }[] };
    expect(all.campaigns).toHaveLength(3);
    expect(all.campaigns.filter((c) => c.tracked)).toHaveLength(1);
  });

  it("classify records the type with an audit row; show and list reflect it", async () => {
    await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    const res = await cli("campaign", "classify", MW4, "--type", "lf", "--reason", "edited gameplay clips from footage");
    expect(res.exitCode).toBe(0);
    expect(await db.select().from(auditLog)).toEqual([
      expect.objectContaining({ action: "classify", actor: "claude-operator", details: expect.objectContaining({ to: "lf" }) }),
    ]);

    const show = (await cli("campaign", "show", `https://contentrewards.com/discover/${MW4}`)).output as {
      campaign: { campaignType: string; contentRewards: { payouts: unknown[] } };
      footageSources: unknown[];
    };
    expect(show.campaign.campaignType).toBe("lf");
    expect(show.campaign.contentRewards.payouts).toHaveLength(3);
    expect(show.footageSources).toEqual([]);

    const list = (await cli("campaign", "list", "--status", "discovered")).output as { campaigns: unknown[] };
    expect(list.campaigns).toHaveLength(1);
    expect(((await cli("campaign", "list", "--status", "active")).output as { campaigns: unknown[] }).campaigns).toHaveLength(0);
  });

  it("flag moves a campaign to needs_attention once, then just records further reasons", async () => {
    await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    expect((await cli("campaign", "flag", MW4, "--reason", "footage on MediaSilo")).output).toMatchObject({
      status: "needs_attention",
      alreadyFlagged: false,
    });
    expect((await cli("campaign", "flag", MW4, "--reason", "also paused")).output).toMatchObject({ alreadyFlagged: true });
    const [row] = await db.select().from(campaigns);
    expect(row).toMatchObject({ status: "needs_attention", statusReason: "footage on MediaSilo" });
  });

  it("brief returns the doc text with inline links, its links, linked sub-docs and reference materials", async () => {
    await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    const res = await cli("campaign", "brief", MW4);
    expect(res.exitCode).toBe(0);
    const out = res.output as {
      doc: { docId: string; text: string; links: { url: string }[] };
      linkedDocs: { text: string; url: string }[];
      referenceMaterials: { url: string }[];
    };
    expect(out.doc.docId).toBe("1AaBbbXTwpIOueM0kFdMC1xB7Leh0Jq3T9C-i6Zowxk4");
    expect(out.doc.text).toContain("Content Folder: <https://drive.google.com/drive/folders/FOLDER123?usp=sharing>");
    expect(out.linkedDocs).toEqual([{ text: "Caption Guide", url: "https://docs.google.com/document/d/SUBDOC789/edit" }]);
    expect(out.referenceMaterials[0]!.url).toContain("docs.google.com/document/d/1AaBbbX");

    const sub = (await cli("campaign", "brief", MW4, "--doc", out.linkedDocs[0]!.url)).output as { doc: { docId: string } };
    expect(sub.doc.docId).toBe("SUBDOC789");
  });

  it("brief works read-only on an untracked campaign, for scouting", async () => {
    const res = await cli("campaign", "brief", `https://contentrewards.com/discover/${MW4}`);
    expect(res.exitCode).toBe(0);
    expect(res.output).toMatchObject({ campaign: { tracked: false, contentRewardsCampaignId: MW4 }, doc: { docId: expect.any(String) } });
    expect(await db.select().from(campaigns)).toHaveLength(0); // nothing written
  });

  it("brief reports a private doc as not_public and a campaign without a doc as doc: null", async () => {
    await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    const priv = await cli("campaign", "brief", MW4, "--doc", "https://docs.google.com/document/d/PRIVATE/edit");
    expect(priv).toEqual({ exitCode: 1, output: { error: { code: "not_public", message: expect.any(String) } } });

    await db.update(campaigns).set({ guidelineDocUrl: null });
    const none = (await cli("campaign", "brief", MW4)).output as { doc: unknown; note: string };
    expect(none.doc).toBeNull();
    expect(none.note).toMatch(/No Google Doc/);
  });

  describe("propose-config", () => {
    beforeEach(async () => {
      await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    });
    const row = async () => (await db.select().from(campaigns))[0]!;

    it("refuses campaigns that aren't classified long-form", async () => {
      const res = await propose(validConfig());
      expect(res.output).toMatchObject({ error: { code: "invalid_state" } });
      await cli("campaign", "classify", MW4, "--type", "ugc", "--reason", "original content");
      expect((await propose(validConfig())).output).toMatchObject({ error: { code: "invalid_state" } });
    });

    it("stores the draft, moves to pending_confirmation, and audits it", async () => {
      await cli("campaign", "classify", MW4, "--type", "lf", "--reason", "footage clipping");
      const res = await propose(validConfig());
      expect(res.exitCode).toBe(0);
      expect(res.output).toMatchObject({ status: "pending_confirmation", unresolved: ["clipGeneration.brandTemplateId"] });
      expect(await row()).toMatchObject({
        status: "pending_confirmation",
        config: { requirements: { requiredTags: ["@callofduty"] } },
        configConfirmedAt: null,
      });
      const audits = await db.select().from(auditLog).where(eq(auditLog.action, "propose_config"));
      expect(audits).toHaveLength(1);
    });

    it("can re-propose a pending draft, and voids an earlier confirmation", async () => {
      await cli("campaign", "classify", MW4, "--type", "lf", "--reason", "footage clipping");
      await propose(validConfig());
      await db.update(campaigns).set({ configConfirmedAt: new Date(), configConfirmedBy: "reviewer:alex" });
      const changed = validConfig();
      changed.requirements.maxAdditionalHashtags = 1;
      expect((await propose(changed)).exitCode).toBe(0);
      expect(await row()).toMatchObject({ configConfirmedAt: null, configConfirmedBy: null });
    });

    it("rejects an invalid config with field-level issues and changes nothing", async () => {
      await cli("campaign", "classify", MW4, "--type", "lf", "--reason", "footage clipping");
      const bad = validConfig();
      bad.review.autoApprove = true;
      const res = await propose(bad);
      expect(res.exitCode).toBe(1);
      expect(res.output).toMatchObject({
        error: { code: "invalid_config", issues: [{ path: "review.autoApprove", message: expect.any(String) }] },
      });
      expect(await row()).toMatchObject({ status: "discovered", config: {} });
    });

    it("--dry-run validates without writing", async () => {
      await cli("campaign", "classify", MW4, "--type", "lf", "--reason", "footage clipping");
      expect((await propose(validConfig(), "--dry-run")).output).toMatchObject({ valid: true, dryRun: true });
      expect((await row()).status).toBe("discovered");
    });

    it("never activates, and refuses to overwrite an active campaign's config", async () => {
      await cli("campaign", "classify", MW4, "--type", "lf", "--reason", "footage clipping");
      await propose(validConfig());
      expect((await row()).status).toBe("pending_confirmation");
      await db.update(campaigns).set({ status: "active" }); // as if a reviewer confirmed
      expect((await propose(validConfig())).output).toMatchObject({ error: { code: "invalid_state" } });
    });

    it("reports unreadable or non-JSON input as a usage error", async () => {
      stdinText = "{not json";
      expect((await cli("campaign", "propose-config", MW4, "--file", "-")).output).toMatchObject({ error: { code: "usage" } });
      expect((await cli("campaign", "propose-config", MW4, "--file", "/no/such/file.json")).output).toMatchObject({
        error: { code: "usage" },
      });
    });
  });

  it("returns structured errors with non-zero exit codes", async () => {
    const cases: [string[], string][] = [
      [["campaign", "frobnicate"], "usage"],
      [["campaign", "add"], "usage"],
      [["campaign", "classify", MW4, "--type", "lf"], "usage"],
      [["campaign", "list", "--bogus"], "usage"],
      [["campaign", "list", "--status", "live"], "invalid_argument"],
      [["campaign", "show", "00000000-0000-0000-0000-000000000000"], "not_found"],
      [["campaign", "add", "https://example.com/discover/x"], "invalid_url"],
      [["campaign", "add", "https://contentrewards.com/discover/00000000-0000-0000-0000-000000000000"], "not_found"],
    ];
    for (const [argv, code] of cases) {
      const res = await cli(...argv);
      expect(res.exitCode, argv.join(" ")).toBe(1);
      expect(res.output, argv.join(" ")).toEqual({ error: { code, message: expect.any(String) } });
    }
  });

  it("guard submit blocks every submission until task 8", async () => {
    const res = await cli("guard", "submit");
    expect(res.exitCode).toBe(2);
    expect(res.output).toMatchObject({ allow: false });
  });

  it("has no command that can activate a campaign or approve a clip", async () => {
    const help = (await cli("help")).output as { commands: Record<string, unknown> };
    for (const name of Object.keys(help.commands)) {
      expect(name).not.toMatch(/approve|activate|confirm|post|publish|join/);
    }
    await cli("campaign", "add", `https://contentrewards.com/discover/${MW4}`);
    const [row] = await db.select().from(campaigns).where(eq(campaigns.contentRewardsCampaignId, MW4));
    expect(row!.status).not.toBe("active");
  });
});
