import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { run } from "../../src/cli/run.js";
import { createDb, type Db } from "../../src/db/client.js";
import { auditLog, campaigns, footageSources, sourceJobs, statusEvents } from "../../src/db/schema.js";
import { resetTestDatabase, TEST_DATABASE_URL, truncateAll } from "../helpers/db.js";
import { insertCampaign } from "../helpers/fixtures.js";

const drive: Record<string, string> = JSON.parse(readFileSync(new URL("../fixtures/drive-folders.json", import.meta.url), "utf8"));
const fakeFetch = vi.fn(async (input: string | URL | Request) => {
  const id = new URL(String(input)).searchParams.get("id") ?? "";
  return new Response(drive[id] ?? "", { status: drive[id] ? 200 : 404 });
}) as unknown as typeof fetch;

const FOLDER = "https://drive.google.com/drive/folders/ROOT?usp=sharing";
const VIDEO = "https://drive.google.com/file/d/VID_RAW1/view";

describe.skipIf(!TEST_DATABASE_URL)("clipper footage …", () => {
  let db: Db;
  let pool: { end(): Promise<void> };
  let campaignId: string;
  const cli = (...argv: string[]) => run(argv, { db, connector: { fetch: fakeFetch } });
  const out = async (...argv: string[]) => (await cli(...argv)).output as any;

  beforeAll(async () => {
    await resetTestDatabase(TEST_DATABASE_URL!);
    ({ db, pool } = createDb(TEST_DATABASE_URL!));
  });
  afterAll(async () => {
    await pool?.end();
  });
  beforeEach(async () => {
    await truncateAll(db);
    const c = await insertCampaign(db, "cr-footage", "active");
    await db.update(campaigns).set({ campaignType: "lf" }).where(eq(campaigns.id, c.id));
    campaignId = c.id;
  });

  it("add registers a footage source once, audited", async () => {
    const first = await out("footage", "add", campaignId, "--url", FOLDER, "--label", "Raw footage", "--reason", "Content Folder link in brief");
    expect(first).toMatchObject({ created: true, role: "folder", footageSource: { kind: "gdrive_folder", label: "Raw footage" } });
    expect(await out("footage", "add", campaignId, "--url", FOLDER, "--reason", "again")).toMatchObject({ created: false });
    expect(await db.select().from(footageSources)).toHaveLength(1);
    expect(await db.select().from(auditLog)).toEqual([expect.objectContaining({ entityType: "footage_source", action: "add" })]);
  });

  it("add refuses hosts OpusClip can't ingest, and non-long-form campaigns", async () => {
    expect(await out("footage", "add", campaignId, "--url", "https://kick.com/x", "--reason", "r")).toMatchObject({
      error: { code: "unsupported_host", message: expect.stringContaining("Kick") },
    });
    await db.update(campaigns).set({ campaignType: "ugc" });
    expect(await out("footage", "add", campaignId, "--url", FOLDER, "--reason", "r")).toMatchObject({ error: { code: "invalid_state" } });
  });

  it("select creates one detected job per video, however often it's repeated", async () => {
    await cli("footage", "add", campaignId, "--url", FOLDER, "--reason", "r");
    const args = ["footage", "select", campaignId, "--url", VIDEO, "--name", "Episode 1.mov", "--path", "Raw to edit", "--from", FOLDER, "--reason", "full episode, raw"];
    const first = await out(...args);
    expect(first).toMatchObject({ created: true, sourceJob: { sourceKey: "gdrive:VID_RAW1", status: "detected", decision: "selected", path: "Raw to edit" } });
    expect(await out(...args)).toMatchObject({ created: false, sourceJob: { id: first.sourceJob.id } });

    const jobs = await db.select().from(sourceJobs);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.footageSourceId).not.toBeNull();
    expect(await db.select().from(statusEvents)).toEqual([
      expect.objectContaining({ entityType: "source_job", fromStatus: null, toStatus: "detected", reason: "full episode, raw" }),
    ]);
  });

  it("skip parks a video in skipped; a conflicting decision is refused", async () => {
    expect(await out("footage", "skip", campaignId, "--url", VIDEO, "--reason", "b-roll")).toMatchObject({
      sourceJob: { status: "skipped", decision: "skipped" },
    });
    expect(await out("footage", "select", campaignId, "--url", VIDEO, "--reason", "changed my mind")).toMatchObject({
      error: { code: "already_decided", message: expect.stringContaining("b-roll") },
    });
    expect(await db.select().from(sourceJobs)).toHaveLength(1);
  });

  it("select refuses folders/channels, unknown --from sources, and missing reasons", async () => {
    expect(await out("footage", "select", campaignId, "--url", FOLDER, "--reason", "r")).toMatchObject({ error: { code: "invalid_argument" } });
    expect(
      await out("footage", "select", campaignId, "--url", VIDEO, "--from", "https://drive.google.com/drive/folders/OTHER", "--reason", "r"),
    ).toMatchObject({ error: { code: "invalid_argument", message: expect.stringContaining("registered") } });
    expect(await out("footage", "select", campaignId, "--url", VIDEO)).toMatchObject({ error: { code: "usage" } });
  });

  it("list-url --campaign marks decided videos so a later run only looks at new ones", async () => {
    await cli("footage", "select", campaignId, "--url", VIDEO, "--reason", "raw episode");
    await cli("footage", "skip", campaignId, "--url", "https://drive.google.com/file/d/VID_BROLL/view", "--reason", "b-roll");
    const listing = await out("footage", "list-url", FOLDER, "--campaign", campaignId);
    const byKey = Object.fromEntries(listing.entries.filter((e: any) => e.sourceKey).map((e: any) => [e.sourceKey, e.decision]));
    expect(byKey).toEqual({
      "gdrive:VID_TOP": null,
      "gdrive:VID_RAW1": "selected",
      "gdrive:VID_BROLL": "skipped",
      "gdrive:VID_DAY1": null,
    });
    expect(listing.undecidedVideos).toBe(2);

    // Without --campaign it's a plain, read-only listing.
    expect((await out("footage", "list-url", FOLDER)).entries[0]).not.toHaveProperty("decision");
  });

  it("list shows sources and decisions with reasons", async () => {
    await cli("footage", "add", campaignId, "--url", FOLDER, "--reason", "brief link");
    await cli("footage", "select", campaignId, "--url", VIDEO, "--reason", "raw episode");
    await cli("footage", "skip", campaignId, "--url", "https://drive.google.com/file/d/VID_BROLL/view", "--reason", "b-roll");
    const all = await out("footage", "list", campaignId);
    expect(all.footageSources).toHaveLength(1);
    expect(all.decisions.map((d: any) => [d.decision, d.reason])).toEqual([
      ["selected", "raw episode"],
      ["skipped", "b-roll"],
    ]);
    expect((await out("footage", "list", campaignId, "--decision", "skipped")).decisions).toHaveLength(1);
  });
});
